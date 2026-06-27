// Coupon source adapters.
// Each adapter fetches an HTML page that lists codes for a given merchant
// and returns an array of { code, title, source } objects.
//
// Sites change layouts often. Each adapter combines structural extraction
// (data attributes, known class names) with a fallback regex pass over the
// raw HTML so we still get something useful when markup shifts.

const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const FETCH_TIMEOUT_MS = 8000;

// Community coupon API (Cloudflare Worker — see worker/README.md). Set this to
// your deployed Worker URL to turn on the shared collection; empty = disabled,
// and everything else works exactly the same.
export const API_BASE = "";

async function fetchJson(url, opts) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, ...opts });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Community-shared codes for a domain, with crowd works/fails counts.
export async function fromCommunity(domain) {
  if (!API_BASE) return [];
  const data = await fetchJson(
    `${API_BASE}/v1/coupons?domain=${encodeURIComponent(domain)}`
  );
  if (!data || !data.ok || !Array.isArray(data.codes)) return [];
  return data.codes
    .filter((c) => isPlausibleCode(String(c.code || "").toUpperCase()))
    .map((c) => ({
      code: String(c.code).toUpperCase(),
      source: "Community",
      pct: c.pct,
      amount: c.amount,
      freeShip: c.freeShip,
      works: c.works || 0,
      fails: c.fails || 0,
    }));
}

// Contribute a code to the shared collection (explicit opt-in only).
export async function submitCommunityCode(domain, code, meta = {}) {
  if (!API_BASE) return false;
  const r = await fetchJson(`${API_BASE}/v1/coupons`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain, code, ...meta }),
  });
  return !!(r && r.ok);
}

// Report whether a code worked, to build the crowd success rate (opt-in).
export async function submitCommunityFeedback(domain, code, status) {
  if (!API_BASE) return false;
  const r = await fetchJson(`${API_BASE}/v1/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain, code, status }),
  });
  return !!(r && r.ok);
}

async function fetchText(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: COMMON_HEADERS,
      signal: controller.signal,
      credentials: "omit",
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Codes look like uppercase alphanumeric strings, often with digits, length 4-20.
// We exclude obvious noise tokens.
const CODE_BLOCKLIST = new Set([
  "HTTPS", "HTML", "JSON", "JAVASCRIPT", "FALSE", "TRUE", "NULL",
  "ERROR", "SUBMIT", "CANCEL", "CLOSE", "LOGIN", "SIGNUP", "EMAIL",
  "PASSWORD", "CHECKOUT", "ACCOUNT", "SEARCH", "FOOTER", "HEADER",
  "BUTTON", "MOBILE", "DESKTOP", "ABOUT", "TERMS", "PRIVACY", "POLICY",
  "CONTACT", "SHIPPING", "RETURN", "REFUND", "CLEARANCE", "CATEGORY",
  "PRODUCT", "PRODUCTS", "STORES", "BRANDS", "COUPON", "COUPONS",
  "PROMO", "PROMOTION", "OFFER", "OFFERS", "DEALS", "SAVE", "SAVINGS",
  "EXPIRED", "TODAY", "WEEK", "MONTH", "DISCOUNT", "FREE", "ONLY",
  "NEW", "OLD", "BEST", "GOOD", "WORK", "WORKS", "WORKED", "VERIFIED",
  "POPULAR", "RECENT", "NEWEST", "OLDEST", "EXCLUSIVE", "LIMITED",
  "VIEW", "SHOW", "HIDE", "MORE", "LESS", "ITEM", "ITEMS", "ORDER",
  "ORDERS", "STORE", "BRAND", "VALID", "TOTAL", "USERS", "USER",
  "STARTS", "ENDS", "OFFERIDS", "CODES", "CODE", "AUTH", "TOKEN",
  "GETID", "GETBY", "VALUEOF", "TARGET", "REACT", "STATE", "PROPS",
  "CONFIG", "OPTIONS", "PARAMS", "NULLABLE", "STRING", "NUMBER",
  "ARRAY", "OBJECT", "BOOLEAN", "INTEGER", "FUNCTION", "PROMISE",
]);

export function isPlausibleCode(s) {
  if (!s) return false;
  if (s.length < 4 || s.length > 20) return false;
  if (!/^[A-Z0-9]+$/.test(s)) return false;
  // Pure numbers are offer/row IDs (e.g. 16580828 from CouponChief), never
  // coupon codes — this is the single biggest source of garbage. Drop them.
  if (/^\d+$/.test(s)) return false;
  if (CODE_BLOCKLIST.has(s)) return false;
  // Require at least one digit OR length >= 5 AND mixed enough not to be a word.
  const hasDigit = /\d/.test(s);
  if (!hasDigit && s.length < 5) return false;
  // Reject single-character repeats like "AAAAA".
  if (/^(.)\1+$/.test(s)) return false;
  return true;
}

// The discount a listing advertises near a code — used downstream to rank by
// how much each code is likely to save (e.g. "30% OFF … BLACKFRIDAY" beats
// "SAVE10"). It only affects try-order, never the measured result, so a noisy
// match is harmless.
export function parseDiscountHint(text) {
  const out = {};
  if (!text) return out;
  const t = String(text).toLowerCase();
  const pct = t.match(/(\d{1,2})\s*%/);
  if (pct) {
    const n = parseInt(pct[1], 10);
    if (n >= 1 && n <= 95) out.pct = n;
  }
  const amt =
    t.match(/\$\s*(\d{1,4})(?:\.\d{2})?\s*(?:off|discount)/) ||
    t.match(/(?:off|save)\s*\$\s*(\d{1,4})/);
  if (amt) {
    const n = parseInt(amt[1], 10);
    if (n >= 1 && n <= 2000) out.amount = n;
  }
  if (/free\s*ship/.test(t)) out.freeShip = true;
  return out;
}

const CODE_CAP_PER_SOURCE = 40; // never let one page flood the queue

export function extractCodesFromHtml(html, sourceName) {
  if (!html) return [];
  const found = new Map();
  // The discount headline usually sits just before the code in its card, so
  // read a window ending a little after the match and parse the offer from it.
  const add = (raw, idx) => {
    const code = String(raw).replace(/[-_]/g, "").toUpperCase();
    if (!isPlausibleCode(code) || found.has(code)) return;
    const window = html.slice(Math.max(0, idx - 320), idx + 60).replace(/<[^>]+>/g, " ");
    found.set(code, { code, title: "", source: sourceName, ...parseDiscountHint(window) });
  };

  let m;
  // 1. Structural attribute extraction: code-bearing attributes used widely.
  const attrRe =
    /(?:data-code|data-clipboard-text|data-promo|data-coupon|data-coupon-code|data-cb-coupon-code|data-cl|data-coupon-id-attr)\s*=\s*["']([A-Z0-9_\-]{4,20})["']/g;
  while ((m = attrRe.exec(html)) !== null) add(m[1], m.index);

  // 2. Element text inside common code containers.
  const codeTagRe =
    /<(?:code|span|div|button)[^>]*class="[^"]*(?:code|promo|coupon|voucher)[^"]*"[^>]*>\s*([A-Z0-9]{4,20})\s*</gi;
  while ((m = codeTagRe.exec(html)) !== null) add(m[1], m.index);

  // 3. Generic "show code" patterns.
  const showCodeRe = /(?:show\s*code|reveal\s*code|copy\s*code)["'>:\s]+([A-Z0-9]{4,20})/gi;
  while ((m = showCodeRe.exec(html)) !== null) add(m[1], m.index);

  return [...found.values()].slice(0, CODE_CAP_PER_SOURCE);
}

// --- Individual adapters -----------------------------------------------------

async function fromCouponFollow(domain) {
  const url = `https://couponfollow.com/site/${domain}`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "CouponFollow");
}

async function fromRetailMeNot(domain) {
  // RetailMeNot uses both a "view" route and a search route — fetch in parallel.
  const urls = [
    `https://www.retailmenot.com/view/${domain}`,
    `https://www.retailmenot.com/s/${domain.split(".")[0]}`,
  ];
  const htmls = await Promise.all(urls.map(fetchText));
  const out = new Map();
  for (const html of htmls) {
    for (const c of extractCodesFromHtml(html, "RetailMeNot")) {
      if (!out.has(c.code)) out.set(c.code, c);
    }
  }
  return [...out.values()];
}

async function fromCouponsCom(domain) {
  const slug = domain.replace(/\./g, "-");
  const url = `https://www.coupons.com/coupon-codes/${slug}`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "Coupons.com");
}

async function fromWethrift(domain) {
  const url = `https://www.wethrift.com/${domain.split(".")[0]}`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "Wethrift");
}

async function fromDealspotr(domain) {
  const slug = domain.split(".")[0];
  const url = `https://dealspotr.com/promo-codes/${slug}.com`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "Dealspotr");
}

async function fromSlickdeals(domain) {
  const slug = domain.split(".")[0];
  const url = `https://slickdeals.net/coupons/${slug}/`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "Slickdeals");
}

async function fromHotDeals(domain) {
  const slug = domain.split(".")[0];
  const url = `https://www.hotdeals.com/promo-codes/${slug}/`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "HotDeals");
}

async function fromCouponCabin(domain) {
  const slug = domain.split(".")[0];
  const url = `https://www.couponcabin.com/coupons/${slug}/`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "CouponCabin");
}

async function fromPromoCodesCom(domain) {
  const slug = domain.split(".")[0];
  const url = `https://www.promocodes.com/coupons/${slug}/`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "PromoCodes.com");
}

async function fromCouponBirds(domain) {
  const url = `https://www.couponbirds.com/codes/${domain}`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "CouponBirds");
}

async function fromKnoji(domain) {
  const slug = domain.split(".")[0];
  const url = `https://${slug}.knoji.com/`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "Knoji");
}

async function fromDontPayFull(domain) {
  const url = `https://www.dontpayfull.com/at/${domain}`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "DontPayFull");
}

async function fromSimplyCodes(domain) {
  const url = `https://simplycodes.com/stores/${domain}`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "SimplyCodes");
}

async function fromCouponChief(domain) {
  const slug = domain.split(".")[0];
  const url = `https://www.couponchief.com/${slug}`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "CouponChief");
}

async function fromGroupon(domain) {
  const slug = domain.split(".")[0];
  const url = `https://www.groupon.com/coupons/${slug}`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "Groupon");
}

async function fromOffers(domain) {
  const slug = domain.split(".")[0];
  const url = `https://www.offers.com/${slug}/`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "Offers.com");
}

async function fromSavings(domain) {
  const slug = domain.split(".")[0];
  const url = `https://www.savings.com/coupons/${slug}/`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "Savings.com");
}

async function fromGoodshop(domain) {
  const slug = domain.split(".")[0];
  const url = `https://www.goodshop.com/coupons/${slug}`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "Goodshop");
}

async function fromCouponSherpa(domain) {
  const slug = domain.split(".")[0];
  const url = `https://www.couponsherpa.com/${slug}/`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "CouponSherpa");
}

// "Hidden" first-order / newsletter / seasonal codes that frequently work but
// aren't always listed on coupon sites. We also derive brand-prefixed guesses
// from the merchant name (e.g. teak -> TEAK10). Marked generated:true so the
// apply loop only reaches them after real, listed codes.
const GENERIC_CODES = [
  "WELCOME", "WELCOME5", "WELCOME10", "WELCOME15", "WELCOME20", "WELCOME25",
  "SAVE5", "SAVE10", "SAVE15", "SAVE20", "SAVE25", "SAVE30",
  "FIRST", "FIRST10", "FIRST15", "FIRST20", "NEW10", "NEW15", "NEW20",
  "TAKE10", "TAKE15", "TAKE20", "GET10", "GET15", "GET20",
  "HELLO10", "HELLO15", "SIGNUP10", "SIGNUP15", "EMAIL10", "EMAIL15",
  "NEWSLETTER", "FREESHIP", "FREESHIPPING", "SHIPFREE",
  "HOLIDAY10", "HOLIDAY20", "HOLIDAY25", "SUMMER10", "SUMMER20",
  "SPRING10", "FALL10", "WINTER10", "THANKYOU10",
  "VIP10", "MEMBER10", "STUDENT10", "EXTRA10", "EXTRA15", "EXTRA20", "BONUS10",
];

async function fromCommonCodes(domain) {
  const slug = (domain.split(".")[0] || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const set = new Set(GENERIC_CODES);
  if (slug.length >= 3) {
    for (const suf of ["", "5", "10", "15", "20", "25"]) set.add(slug + suf);
  }
  const out = [];
  for (const code of set) {
    if (isPlausibleCode(code)) {
      out.push({ code, title: "Common code", source: "Common/Hidden", generated: true });
    }
  }
  return out;
}

async function fromGoogleSearch(domain) {
  // Use the public html results page. Heavy throttling possible — keep last.
  const q = encodeURIComponent(`${domain} coupon code site:reddit.com OR site:couponfollow.com`);
  const url = `https://www.google.com/search?q=${q}`;
  const html = await fetchText(url);
  return extractCodesFromHtml(html, "Google");
}

const ADAPTERS = [
  fromCommunity,
  fromCouponFollow,
  fromRetailMeNot,
  fromCouponsCom,
  fromWethrift,
  fromDealspotr,
  fromSlickdeals,
  fromHotDeals,
  fromCouponCabin,
  fromPromoCodesCom,
  fromCouponBirds,
  fromKnoji,
  fromDontPayFull,
  fromSimplyCodes,
  fromCouponChief,
  fromGroupon,
  fromOffers,
  fromSavings,
  fromGoodshop,
  fromCouponSherpa,
  fromGoogleSearch,
  fromCommonCodes,
];

/**
 * Merge every source's codes into one list, recording cross-source CONSENSUS:
 * how many independent coupon sites listed each code. A code corroborated by
 * many sites is far likelier to be live, so we attach `sourceCount` and sort by
 * it — the single strongest signal an aggregator has. Generated guesses don't
 * count toward consensus (they aren't an independent listing). Pure function so
 * it's unit-tested directly.
 */
export function dedupeWithConsensus(flat) {
  const byCode = new Map();
  for (const c of flat || []) {
    if (!c || !c.code) continue;
    let rec = byCode.get(c.code);
    if (!rec) {
      rec = { obj: { ...c }, sources: new Set() };
      byCode.set(c.code, rec);
    } else {
      // A real, listed code beats a generated guess of the same string.
      if (rec.obj.generated && !c.generated) rec.obj = { ...c };
      // Fill in advertised-discount info from whichever source had it.
      if (rec.obj.pct == null && c.pct != null) rec.obj.pct = c.pct;
      if (rec.obj.amount == null && c.amount != null) rec.obj.amount = c.amount;
      if (!rec.obj.freeShip && c.freeShip) rec.obj.freeShip = true;
    }
    if (c.source && !c.generated) rec.sources.add(c.source);
  }
  // Keep only the count (not the source list) — leaner messages + cache.
  const out = [...byCode.values()].map(({ obj, sources }) => ({
    ...obj,
    sourceCount: sources.size,
  }));
  out.sort((a, b) => b.sourceCount - a.sourceCount);
  return out;
}

/**
 * Fan out to every adapter in parallel, then merge with cross-source consensus.
 * onSourceDone is called as each adapter resolves so the UI can stream progress.
 */
export async function gatherCoupons(domain, onSourceDone) {
  const flat = [];
  await Promise.all(
    ADAPTERS.map(async (adapter) => {
      const name = adapter.name.replace(/^from/, "");
      let codes = [];
      try {
        codes = (await adapter(domain)) || [];
      } catch {
        codes = [];
      }
      for (const c of codes) flat.push(c);
      if (onSourceDone) {
        try {
          onSourceDone({ source: name, found: codes.length });
        } catch {}
      }
    })
  );
  return dedupeWithConsensus(flat);
}

export const SOURCE_NAMES = ADAPTERS.map((a) => a.name.replace(/^from/, ""));
