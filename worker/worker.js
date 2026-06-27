// Coupon Hunter — community API (Cloudflare Worker + D1).
// Anonymous, no accounts, no PII. Three endpoints:
//   GET  /v1/coupons?domain=store.com   → codes others have shared, crowd-ranked
//   POST /v1/coupons   {domain,code,pct?,amount?,freeship?}  → contribute a code
//   POST /v1/feedback  {domain,code,status:"working"|"failed"} → crowd success rate
//
// Deploy:  cd worker && wrangler deploy   (see README.md)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

// --- validation -------------------------------------------------------------
const CODE_RE = /^[A-Z0-9]{4,20}$/;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function cleanDomain(d) {
  d = String(d || "").toLowerCase().trim().replace(/^www\./, "");
  return DOMAIN_RE.test(d) && d.length <= 80 ? d : null;
}
function cleanCode(c) {
  c = String(c || "").toUpperCase().trim();
  return CODE_RE.test(c) ? c : null;
}
function intOrNull(v, min, max) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

const MAX_CODES_PER_DOMAIN = 300; // anti-flood ceiling per store

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/v1/coupons") {
        const domain = cleanDomain(url.searchParams.get("domain"));
        if (!domain) return json({ ok: false, error: "bad-domain" }, 400);
        const { results } = await env.DB.prepare(
          `SELECT code, pct, amount, freeship, works, fails
             FROM coupons WHERE domain = ?
            ORDER BY (works - fails) DESC, works DESC
            LIMIT 100`
        )
          .bind(domain)
          .all();
        return json({
          ok: true,
          domain,
          codes: (results || []).map((r) => ({
            code: r.code,
            pct: r.pct ?? undefined,
            amount: r.amount ?? undefined,
            freeShip: !!r.freeship || undefined,
            works: r.works,
            fails: r.fails,
            source: "Community",
          })),
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/coupons") {
        const body = await request.json().catch(() => ({}));
        const domain = cleanDomain(body.domain);
        const code = cleanCode(body.code);
        if (!domain || !code) return json({ ok: false, error: "invalid" }, 400);
        const pct = intOrNull(body.pct, 1, 95);
        const amount = intOrNull(body.amount, 1, 2000);
        const freeship = body.freeShip ? 1 : 0;
        const now = Date.now();

        const count = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM coupons WHERE domain = ?`
        )
          .bind(domain)
          .first("n");
        if (count >= MAX_CODES_PER_DOMAIN)
          return json({ ok: false, error: "domain-full" }, 429);

        await env.DB.prepare(
          `INSERT INTO coupons (domain, code, pct, amount, freeship, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(domain, code) DO UPDATE SET
             pct = COALESCE(excluded.pct, coupons.pct),
             amount = COALESCE(excluded.amount, coupons.amount),
             freeship = MAX(coupons.freeship, excluded.freeship),
             updated_at = excluded.updated_at`
        )
          .bind(domain, code, pct, amount, freeship, now, now)
          .run();
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/feedback") {
        const body = await request.json().catch(() => ({}));
        const domain = cleanDomain(body.domain);
        const code = cleanCode(body.code);
        if (!domain || !code) return json({ ok: false, error: "invalid" }, 400);
        const col = body.status === "working" ? "works" : "fails";
        const now = Date.now();
        // Only counts toward codes that exist; insert the row if a working code
        // isn't in the table yet (someone found it elsewhere).
        await env.DB.prepare(
          `INSERT INTO coupons (domain, code, ${col}, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(domain, code) DO UPDATE SET
             ${col} = coupons.${col} + 1, updated_at = excluded.updated_at`
        )
          .bind(domain, code, now, now)
          .run();
        return json({ ok: true });
      }

      if (url.pathname === "/" || url.pathname === "/v1/health") {
        return json({ ok: true, service: "coupon-hunter-community" });
      }
      return json({ ok: false, error: "not-found" }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  },
};
