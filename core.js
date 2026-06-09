// Coupon Hunter — shared pure logic (no DOM, no chrome APIs).
// Loaded as the first content script (so content.js can use `CHCore`) and
// exercised directly by the test suite. Keep this file side-effect free.

(function () {
  // -- Domain / POS resolution ------------------------------------------------
  function rootDomainOf(host) {
    if (!host) return "";
    const h = host.toLowerCase().replace(/^www\./, "");
    const parts = h.split(".");
    if (parts.length < 3) return h;
    const last2 = parts.slice(-2).join(".");
    const last3 = parts.slice(-3).join(".");
    return /\.(co|com|org|gov|ac|net)\.[a-z]{2}$/.test(h) ? last3 : last2;
  }

  const POS_HOSTS = new Set([
    "shop.app", "shopify.com", "myshopify.com", "checkout.shopify.com",
    "checkout.stripe.com", "pay.stripe.com", "buy.stripe.com", "js.stripe.com",
    "pay.google.com", "googlepay.com", "paypal.com", "paypalobjects.com",
    "squareup.com", "square.site", "checkout.square.site", "bolt.com",
    "fast.co", "checkout.com", "link.com", "afterpay.com", "klarna.com",
    "sezzle.com", "affirm.com", "global-e.com", "digitalriver.com",
    "fastspring.com", "recurly.com", "chargebee.com", "snipcart.com",
    "amazonpay.com", "braintreegateway.com", "adyen.com",
  ]);
  const IGNORE_DOMAINS = new Set([
    "google.com", "gstatic.com", "googleapis.com", "googletagmanager.com",
    "google-analytics.com", "doubleclick.net", "facebook.com", "fbcdn.net",
    "cloudflare.com", "cloudfront.net", "jsdelivr.net", "unpkg.com", "w3.org",
    "schema.org", "gmail.com", "googleusercontent.com", "shopifycdn.com",
    "shopifysvc.com", "recaptcha.net", "cdninstagram.com", "twitter.com",
    "x.com", "youtube.com", "apple.com", "bing.com", "microsoft.com",
    "licdn.com", "tiktok.com", "klaviyo.com", "hotjar.com", "sentry.io",
    "cookielaw.org", "onetrust.com",
  ]);

  function isPOS(host) {
    if (!host) return false;
    host = host.toLowerCase().replace(/^www\./, "");
    return POS_HOSTS.has(host) || POS_HOSTS.has(rootDomainOf(host));
  }

  // Most-referenced outbound domain in the page HTML that isn't infra or a
  // processor — used to attribute hosted checkouts to the real store.
  function guessMerchantFromHtml(html) {
    const re = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;
    const counts = new Map();
    let m;
    while ((m = re.exec(html || "")) !== null) {
      const root = rootDomainOf(m[1]);
      if (!root || root.split(".").length < 2) continue;
      if (isPOS(root) || IGNORE_DOMAINS.has(root)) continue;
      counts.set(root, (counts.get(root) || 0) + 1);
    }
    let best = null, n = 0;
    for (const [d, c] of counts) if (c > n) { n = c; best = d; }
    return n >= 2 ? best : null;
  }

  // -- Code validation / merge ------------------------------------------------
  const CODE_BLOCKLIST = new Set([
    "CHECKOUT", "SHIPPING", "DISCOUNT", "COUPON", "PROMO", "SUBTOTAL",
    "PAYMENT", "BILLING", "ADDRESS", "EXPRESS", "COMPANY", "OPTIONAL",
    "ENGLISH", "COUNTRY", "FREE", "GIFT", "CARD", "CODE", "EMAIL", "PHONE",
    "APPLY", "ORDER", "TOTAL", "PRICE", "ITEMS", "STORE", "RETURN", "POLICY",
    "TERMS", "SUBMIT", "CANCEL", "SEARCH", "ACCOUNT", "REDEEM", "REMOVE",
  ]);
  function isGoodCode(raw) {
    const s = String(raw || "").toUpperCase().trim();
    if (s.length < 4 || s.length > 20) return false;
    if (!/^[A-Z0-9]+$/.test(s)) return false;
    if (/^\d+$/.test(s)) return false; // pure number = an ID, not a coupon
    if (/^(.)\1+$/.test(s)) return false; // AAAAAA
    if (CODE_BLOCKLIST.has(s)) return false;
    if (!/\d/.test(s) && s.length < 5) return false;
    return true;
  }

  // Merge code lists: drop generic guesses + junk, dedupe, earlier lists win.
  function mergeCodes(...lists) {
    const out = new Map();
    for (const list of lists) {
      for (const c of list || []) {
        if (c && c.generated) continue;
        const code = String((c && c.code) || "").toUpperCase();
        if (code && isGoodCode(code) && !out.has(code)) {
          out.set(code, Object.assign({}, c, { code }));
        }
      }
    }
    return [...out.values()];
  }

  // Codes a store advertises in its own page text ("use code SUMMER20").
  const ON_PAGE_PATTERNS = [
    /(?:use|enter|apply|with|redeem)\s+(?:the\s+)?(?:promo|coupon|discount|voucher)?\s*code[:\s"'•-]+([A-Za-z0-9]{4,20})/gi,
    /(?:promo|coupon|discount|voucher)\s*code[:\s"'•-]+([A-Za-z0-9]{4,20})/gi,
    /\bcode\s+([A-Z0-9]{4,20})\b(?=[^a-z]{0,40}(?:checkout|save|off|order|discount))/gi,
  ];
  function scanCodesFromText(text) {
    const out = new Map();
    for (const re of ON_PAGE_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text || "")) !== null) {
        const code = String(m[1] || "").toUpperCase();
        if (isGoodCode(code) && !out.has(code)) {
          out.set(code, { code, source: "On this page", onPage: true });
        }
      }
    }
    return [...out.values()];
  }

  // -- Button safety classifier ----------------------------------------------
  const APPLY_POSITIVE =
    /\b(apply|redeem)\b|\b(apply|use|add|enter|submit)\b[^.]{0,24}\b(code|coupon|promo|promotion|voucher|discount|gift\s?card)\b/i;
  const APPLY_DANGER =
    /\b(place|submit|complete|confirm|review)\b[^.]{0,14}\border\b|\bplace\s+your\s+order\b|\bpay\b|\bpay\s+now\b|\bbuy\s+now\b|\bpurchase\b|\bcheck\s?out\b|\bcontinue\b|\bproceed\b|\bnext\b|\bgo\s+to\s+(payment|checkout|shipping)\b|\bcomplete\s+(purchase|payment)\b/i;

  function isDangerButtonText(text) {
    return APPLY_DANGER.test(String(text || ""));
  }

  // Returns 'danger' (never click), 'apply' (safe coupon button), or 'none'.
  function classifyButtonLabel(text) {
    const t = String(text || "").trim();
    if (!t || t.length > 40) return "none";
    if (APPLY_DANGER.test(t)) return "danger";
    return APPLY_POSITIVE.test(t) ? "apply" : "none";
  }

  // -- Apply-result classifier ------------------------------------------------
  const RE_RATELIMIT =
    /too many (?:attempts|tries|requests)|try again (?:later|in a|after)|please (?:wait|slow)|slow down|maximum.{0,12}attempts|temporarily (?:blocked|locked|unavailable)/;
  const RE_INVALID =
    /invalid (?:promo|coupon|discount|gift|code)|(?:promo|coupon|discount)\s*code\s*(?:is\s*)?(?:invalid|expired|not valid)|not a valid (?:promo|coupon|discount)|isn['’]?t valid|enter a valid|coupon.{0,12}not found|can['’]?t (?:find|apply|use).{0,16}code|no longer (?:valid|available)|code (?:has )?expired|does(?:n['’]?t| not) exist/;
  const RE_SUCCESS =
    /(?:promo|coupon|discount|code)\s*(?:successfully\s*)?(?:applied|added|activated)|discount applied|you saved|savings applied/;

  // Returns 'ratelimit' | 'invalid' | 'success' | '' from page body text.
  function classifyResultText(text) {
    const body = String(text || "").toLowerCase();
    if (RE_RATELIMIT.test(body)) return "ratelimit";
    if (RE_INVALID.test(body)) return "invalid";
    if (RE_SUCCESS.test(body)) return "success";
    return "";
  }

  // -- Money / savings math ---------------------------------------------------
  function parseMoney(text) {
    if (!text) return null;
    const m = String(text).replace(/,/g, "").match(/-?\$?\s*(\d+(?:\.\d{1,2})?)/);
    return m ? parseFloat(m[1]) : null;
  }

  // Discount implied by the digits in a code (SAVE40 -> 40). Ignores years/IDs.
  function potentialFromCode(code) {
    const nums = (String(code).match(/\d+/g) || [])
      .map(Number)
      .filter((n) => n >= 1 && n <= 99);
    return nums.length ? Math.max(...nums) : 0;
  }

  // Upper bound in dollars a code could save: max(N%, $N), or a cap for
  // no-number codes (free shipping etc.). Used for the provably-worse early exit.
  function ceilSavings(code, baseline, freeShipCap) {
    const cap = typeof freeShipCap === "number" ? freeShipCap : 30;
    const n = potentialFromCode(code);
    if (!n) return cap;
    return baseline != null ? Math.max(n, (n / 100) * baseline) : n;
  }

  const CHCore = {
    rootDomainOf,
    POS_HOSTS,
    IGNORE_DOMAINS,
    isPOS,
    guessMerchantFromHtml,
    CODE_BLOCKLIST,
    isGoodCode,
    mergeCodes,
    scanCodesFromText,
    APPLY_POSITIVE,
    APPLY_DANGER,
    isDangerButtonText,
    classifyButtonLabel,
    RE_RATELIMIT,
    RE_INVALID,
    RE_SUCCESS,
    classifyResultText,
    parseMoney,
    potentialFromCode,
    ceilSavings,
  };

  // Expose: browser content-script world + Node test harness (vm/global).
  if (typeof globalThis !== "undefined") globalThis.CHCore = CHCore;
  if (typeof module !== "undefined" && module.exports) module.exports = CHCore;
})();
