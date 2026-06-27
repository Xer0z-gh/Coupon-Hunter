// Coupon Hunter — service worker.
// Responsibilities:
//   * Coordinate coupon hunts kicked off from the popup or content script.
//   * Fan out to every source adapter in sources.js.
//   * Persist results per-domain so repeat visits show the latest known codes.
//   * Relay progress + final results back to whichever surface asked.

import {
  gatherCoupons,
  SOURCE_NAMES,
  submitCommunityCode,
  submitCommunityFeedback,
} from "./sources.js";

const STORAGE_PREFIX = "cohunt:cache:";
const DEFAULT_TTL_HOURS = 1; // keep codes fresh by default
const CACHE_REVALIDATE_MS = 1000 * 60 * 20; // refresh in background after 20 min

// The popup exposes "Cache TTL (hours)" — honor it here. Cached in memory and
// kept current via onChanged (the worker re-reads on every cold start anyway).
let cacheTtlMs = DEFAULT_TTL_HOURS * 3600 * 1000;
function applyTtlHours(raw) {
  const h = parseFloat(raw);
  if (Number.isFinite(h) && h >= 1) cacheTtlMs = Math.min(h, 168) * 3600 * 1000;
}
// Share anonymous "this code worked/failed" feedback with the community to build
// crowd success rates — the data flywheel that makes shared codes great. ON by
// default (anonymous, no PII); one toggle in Settings turns it off.
let shareFeedback = true;
chrome.storage.sync
  .get(["optTtl", "optShareFeedback"])
  .then((o) => {
    applyTtlHours(o.optTtl);
    shareFeedback = o.optShareFeedback !== false;
  })
  .catch(() => {});
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "sync") return;
  if (ch.optTtl) applyTtlHours(ch.optTtl.newValue);
  if (ch.optShareFeedback) shareFeedback = ch.optShareFeedback.newValue !== false;
});

// Codes the user added by hand for a store (Tab 3). Stored locally and merged
// into every hunt for that store so they're tried first-class.
function userKey(domain) {
  return `cohunt:user:${domain}`;
}
async function getUserCodes(domain) {
  const key = userKey(domain);
  const obj = await chrome.storage.local.get(key);
  return obj[key] || [];
}
async function mergeUserCodes(domain, codes) {
  const user = await getUserCodes(domain);
  if (!user.length) return codes;
  const seen = new Set(codes.map((c) => c.code));
  const extra = user
    .filter((u) => !seen.has(u.code))
    .map((u) => ({ ...u, source: "Added by you", userAdded: true }));
  return [...extra, ...codes];
}

// Hosted checkouts / processors — never pre-warm these as if they were stores.
const POS_HOSTS = new Set([
  "shop.app", "shopify.com", "myshopify.com", "checkout.shopify.com",
  "checkout.stripe.com", "pay.stripe.com", "buy.stripe.com", "js.stripe.com",
  "pay.google.com", "googlepay.com", "paypal.com", "squareup.com",
  "square.site", "checkout.square.site", "bolt.com", "fast.co", "checkout.com",
  "link.com", "afterpay.com", "klarna.com", "sezzle.com", "affirm.com",
  "global-e.com", "digitalriver.com", "fastspring.com", "recurly.com",
  "chargebee.com", "snipcart.com", "amazonpay.com", "adyen.com",
]);

// Lifetime savings ledger — the headline value-prop in the popup. Free, fully
// local, and never leaves the browser.
const SAVINGS_KEY = "cohunt:savings";
async function recordSaving(domain, code, savings) {
  if (typeof savings !== "number" || !(savings > 0)) return;
  const obj = await chrome.storage.local.get(SAVINGS_KEY);
  const s = obj[SAVINGS_KEY] || { total: 0, count: 0, stores: [], history: [] };
  s.total = Math.round((s.total + savings) * 100) / 100;
  s.count += 1;
  if (!s.stores.includes(domain)) s.stores.push(domain);
  s.history.unshift({ domain, code, savings, ts: Date.now() });
  s.history = s.history.slice(0, 50);
  await chrome.storage.local.set({ [SAVINGS_KEY]: s });
}

function cacheKey(domain) {
  return STORAGE_PREFIX + domain;
}

async function readCache(domain) {
  const key = cacheKey(domain);
  const obj = await chrome.storage.local.get(key);
  const hit = obj[key];
  if (!hit) return null;
  if (Date.now() - hit.ts > cacheTtlMs) return null;
  return hit;
}

async function writeCache(domain, payload) {
  await chrome.storage.local.set({
    [cacheKey(domain)]: { ts: Date.now(), ...payload },
  });
}

function rootDomain(host) {
  if (!host) return null;
  let h = host.toLowerCase().replace(/^www\./, "");
  // Strip subdomains for two-label TLDs we commonly see.
  const parts = h.split(".");
  if (parts.length >= 3) {
    const last2 = parts.slice(-2).join(".");
    const last3 = parts.slice(-3).join(".");
    const ccTld2 = /\.(co|com|org|gov|ac|net)\.[a-z]{2}$/.test(h);
    h = ccTld2 ? last3 : last2;
  }
  return h;
}

const liveHunts = new Map(); // domain -> Promise

async function huntForDomain(domain, { force = false } = {}) {
  if (!force) {
    const cached = await readCache(domain);
    if (cached?.codes?.length) {
      broadcastProgress(domain, { phase: "cached", codes: cached.codes });
      // Stale-while-revalidate: serve cache instantly, refresh in the
      // background once it's getting old so the next look is fresher.
      if (Date.now() - cached.ts > CACHE_REVALIDATE_MS && !liveHunts.has(domain)) {
        runHunt(domain).catch(() => {});
      }
      return cached.codes;
    }
  }
  return runHunt(domain);
}

function runHunt(domain) {
  if (liveHunts.has(domain)) {
    return liveHunts.get(domain);
  }

  broadcastProgress(domain, {
    phase: "starting",
    sources: SOURCE_NAMES,
  });

  const promise = (async () => {
    const codes = await gatherCoupons(domain, (evt) => {
      broadcastProgress(domain, { phase: "source-done", ...evt });
    });
    await writeCache(domain, { codes });
    broadcastProgress(domain, { phase: "complete", codes });
    return codes;
  })().finally(() => {
    liveHunts.delete(domain);
  });

  liveHunts.set(domain, promise);
  return promise;
}

async function broadcastProgress(domain, payload) {
  // Extension surfaces (popup, options) — reached via runtime.sendMessage.
  chrome.runtime
    .sendMessage({ type: "hunt-progress", domain, ...payload })
    .catch(() => {});

  // Content scripts — only reached via tabs.sendMessage. Push to any open
  // tab whose hostname maps to this domain so the on-page card streams too.
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.url || !t.id) continue;
      let host;
      try {
        host = new URL(t.url).hostname;
      } catch {
        continue;
      }
      if (rootDomain(host) === domain) {
        chrome.tabs
          .sendMessage(t.id, { type: "hunt-progress", domain, ...payload })
          .catch(() => {});
      }
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "hunt": {
          const domain = rootDomain(msg.domain);
          if (!domain) return sendResponse({ ok: false, error: "no-domain" });
          const codes = await huntForDomain(domain, { force: !!msg.force });
          sendResponse({ ok: true, domain, codes: await mergeUserCodes(domain, codes) });
          break;
        }
        case "get-cached": {
          const domain = rootDomain(msg.domain);
          if (!domain) return sendResponse({ ok: false, error: "no-domain" });
          const cached = await readCache(domain);
          sendResponse({
            ok: true,
            domain,
            codes: await mergeUserCodes(domain, cached?.codes || []),
          });
          break;
        }
        case "record-result": {
          // Content script reports working/failed codes so we can rank them next time.
          const domain = rootDomain(msg.domain);
          if (!domain) return sendResponse({ ok: false });
          const key = `cohunt:results:${domain}`;
          const obj = await chrome.storage.local.get(key);
          const log = obj[key] || {};
          log[msg.code] = {
            status: msg.status,
            ts: Date.now(),
            savings: msg.savings || null,
          };
          await chrome.storage.local.set({ [key]: log });
          // Bank the win + nudge the user when real money is saved.
          if (msg.status === "working" && typeof msg.savings === "number" && msg.savings > 0) {
            await recordSaving(domain, msg.code, msg.savings);
            chrome.notifications
              ?.create({
                type: "basic",
                iconUrl: "icons/icon128.png",
                title: "Coupon Hunter saved you money",
                message: `${msg.code} took $${msg.savings.toFixed(2)} off at ${domain}.`,
                priority: 2,
              })
              .catch(() => {});
          }
          // Crowd success rate — only when the user has opted in.
          if (shareFeedback && (msg.status === "working" || msg.status === "failed")) {
            submitCommunityFeedback(domain, msg.code, msg.status).catch(() => {});
          }
          sendResponse({ ok: true });
          break;
        }
        case "user-add": {
          const domain = rootDomain(msg.domain);
          const code = String(msg.code || "").toUpperCase().trim();
          if (!domain || !/^[A-Z0-9]{4,20}$/.test(code)) {
            return sendResponse({ ok: false, error: "invalid" });
          }
          const meta = {};
          if (Number.isFinite(msg.pct)) meta.pct = msg.pct;
          if (Number.isFinite(msg.amount)) meta.amount = msg.amount;
          if (msg.freeShip) meta.freeShip = true;
          const list = await getUserCodes(domain);
          if (!list.some((c) => c.code === code)) {
            list.unshift({ code, ...meta, ts: Date.now() });
            await chrome.storage.local.set({ [userKey(domain)]: list.slice(0, 100) });
          }
          // Explicit opt-in: also contribute it to the shared collection.
          let shared = false;
          if (msg.share) shared = await submitCommunityCode(domain, code, meta);
          sendResponse({ ok: true, shared });
          break;
        }
        case "user-list": {
          const domain = rootDomain(msg.domain);
          if (!domain) return sendResponse({ ok: true, codes: [] });
          sendResponse({ ok: true, codes: await getUserCodes(domain) });
          break;
        }
        case "user-remove": {
          const domain = rootDomain(msg.domain);
          const code = String(msg.code || "").toUpperCase();
          const list = (await getUserCodes(domain)).filter((c) => c.code !== code);
          await chrome.storage.local.set({ [userKey(domain)]: list });
          sendResponse({ ok: true });
          break;
        }
        case "get-results-log": {
          const domain = rootDomain(msg.domain);
          if (!domain) return sendResponse({ ok: false });
          const key = `cohunt:results:${domain}`;
          const obj = await chrome.storage.local.get(key);
          sendResponse({ ok: true, log: obj[key] || {} });
          break;
        }
        case "open-popup": {
          // Content script asks to be noticed -- set a badge.
          if (sender.tab?.id) {
            chrome.action.setBadgeText({
              tabId: sender.tab.id,
              text: msg.count ? String(msg.count) : "",
            });
            chrome.action.setBadgeBackgroundColor({
              tabId: sender.tab.id,
              color: "#2563eb",
            });
          }
          sendResponse({ ok: true });
          break;
        }
        case "get-savings": {
          const obj = await chrome.storage.local.get(SAVINGS_KEY);
          const s = obj[SAVINGS_KEY] || {
            total: 0,
            count: 0,
            stores: [],
            history: [],
          };
          sendResponse({
            ok: true,
            total: s.total,
            count: s.count,
            stores: s.stores.length,
            history: s.history,
          });
          break;
        }
        case "reset-savings": {
          await chrome.storage.local.set({
            [SAVINGS_KEY]: { total: 0, count: 0, stores: [], history: [] },
          });
          sendResponse({ ok: true });
          break;
        }
        case "get-site-state": {
          const domain = rootDomain(msg.domain);
          const obj = await chrome.storage.sync.get([
            "optEnabled",
            "cohunt:disabledSites",
          ]);
          sendResponse({
            ok: true,
            domain,
            enabled: obj.optEnabled !== false,
            siteDisabled: (obj["cohunt:disabledSites"] || []).includes(domain),
          });
          break;
        }
        case "set-enabled": {
          await chrome.storage.sync.set({ optEnabled: !!msg.enabled });
          sendResponse({ ok: true });
          break;
        }
        case "set-site-enabled": {
          const domain = rootDomain(msg.domain);
          if (!domain) return sendResponse({ ok: false });
          const obj = await chrome.storage.sync.get("cohunt:disabledSites");
          let list = obj["cohunt:disabledSites"] || [];
          if (msg.enabled) list = list.filter((d) => d !== domain);
          else if (!list.includes(domain)) list.push(domain);
          await chrome.storage.sync.set({ "cohunt:disabledSites": list });
          sendResponse({ ok: true, siteDisabled: !msg.enabled });
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown-type" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // keep channel open for async sendResponse
});

// Keyboard shortcut (Ctrl/Cmd+Shift+U) → trigger a hunt+apply on the active tab.
chrome.commands?.onCommand.addListener(async (cmd) => {
  if (cmd !== "apply-coupons") return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: "cohunt:trigger" }).catch(() => {});
    }
  } catch {}
});

// On tab navigation, kick off a background hunt so the popup feels instant.
chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.status !== "complete" || !tab.url) return;
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return;
  }
  if (!/^https?:$/.test(url.protocol)) return;
  const hostNoWww = url.hostname.toLowerCase().replace(/^www\./, "");
  // On hosted checkouts the host is the processor, not a store — the content
  // script resolves the real merchant. Don't pre-warm the processor's domain.
  if (POS_HOSTS.has(hostNoWww) || POS_HOSTS.has(rootDomain(url.hostname))) return;
  const domain = rootDomain(url.hostname);
  if (!domain) return;
  const cached = await readCache(domain);
  if (cached?.codes?.length) {
    chrome.action.setBadgeText({
      tabId,
      text: String(cached.codes.length),
    });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
  } else {
    // Pre-warm in background so popup is instant on first click.
    huntForDomain(domain).catch(() => {});
  }
});

// Default to fully-automatic behaviour on first install (opt-out, not opt-in)
// so the extension saves money with zero interaction out of the box.
chrome.runtime.onInstalled.addListener(async (details) => {
  const cur = await chrome.storage.sync.get([
    "optEnabled",
    "optAutoHunt",
    "optAutoApply",
    "optFloatCard",
    "optShareFeedback",
  ]);
  const defaults = {};
  if (cur.optEnabled === undefined) defaults.optEnabled = true;
  if (cur.optAutoHunt === undefined) defaults.optAutoHunt = true;
  if (cur.optAutoApply === undefined) defaults.optAutoApply = true;
  if (cur.optFloatCard === undefined) defaults.optFloatCard = true;
  if (cur.optShareFeedback === undefined) defaults.optShareFeedback = true;
  if (Object.keys(defaults).length) await chrome.storage.sync.set(defaults);

  // Friendly welcome on first install.
  if (details.reason === "install") {
    chrome.tabs
      .create({ url: chrome.runtime.getURL("welcome.html") })
      .catch(() => {});
  }
});
