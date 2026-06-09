// Coupon Hunter — content script.
// Runs on every page. When it spots a coupon-code input it:
//   1. Asks the background worker for codes for the current domain.
//   2. Presents a floating Notion-style card on the page.
//   3. On user opt-in (or auto if enabled), iterates through codes,
//      applying each via the page's existing apply button and watching
//      the order total for a real change.

(() => {
  if (window.__couponHunterLoaded) return;
  window.__couponHunterLoaded = true;

  // Pure, unit-tested logic lives in core.js (loaded as the first content
  // script). Alias what we use so the rest of this file reads unchanged.
  const CHCore = globalThis.CHCore;
  const {
    rootDomainOf,
    isPOS,
    isGoodCode,
    mergeCodes,
    parseMoney,
    classifyResultText,
    classifyButtonLabel,
    isDangerButtonText,
    potentialFromCode,
    ceilSavings,
  } = CHCore;
  const rootDomain = rootDomainOf(location.hostname);

  // -- Third-party checkout / POS detection -----------------------------------
  // On hosted checkouts (Shop Pay, Stripe, PayPal, Square, Klarna, etc.) the
  // page's own domain is the PROCESSOR, not the store. We resolve the REAL
  // merchant the cart belongs to and hunt + apply for that domain only.
  function guessMerchantFromPage() {
    return CHCore.guessMerchantFromHtml(
      document.documentElement.outerHTML || ""
    );
  }

  // The store domain we hunt + apply codes for. Returns null on a POS page we
  // can't attribute — in which case we deliberately do NOT hunt, so we never
  // apply some other shop's codes to your order.
  function resolveMerchant() {
    const here = location.hostname.toLowerCase().replace(/^www\./, "");
    if (!isPOS(here)) return rootDomainOf(here);
    try {
      if (document.referrer) {
        const rh = new URL(document.referrer).hostname;
        if (rh && !isPOS(rh)) return rootDomainOf(rh);
      }
    } catch {}
    return guessMerchantFromPage();
  }

  let huntDomain = null; // resolved store domain for this checkout

  // -- Settings (default everything ON so it works with zero interaction) -----
  const settings = {
    enabled: true,
    autoHunt: true,
    autoApply: true,
    floatCard: true,
    disabledSites: [],
  };
  let settingsLoaded = false;
  chrome.storage.sync
    .get([
      "optEnabled",
      "optAutoHunt",
      "optAutoApply",
      "optFloatCard",
      "cohunt:disabledSites",
    ])
    .then((o) => {
      settings.enabled = o.optEnabled !== false;
      settings.autoHunt = o.optAutoHunt !== false;
      settings.autoApply = o.optAutoApply !== false;
      settings.floatCard = o.optFloatCard !== false;
      settings.disabledSites = o["cohunt:disabledSites"] || [];
      settingsLoaded = true;
      autoTrigger();
    })
    .catch(() => {
      settingsLoaded = true;
      autoTrigger();
    });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "sync") return;
    if (ch.optEnabled) settings.enabled = ch.optEnabled.newValue !== false;
    if (ch.optAutoHunt) settings.autoHunt = ch.optAutoHunt.newValue !== false;
    if (ch.optAutoApply) settings.autoApply = ch.optAutoApply.newValue !== false;
    if (ch.optFloatCard) settings.floatCard = ch.optFloatCard.newValue !== false;
    if (ch["cohunt:disabledSites"]) {
      settings.disabledSites = ch["cohunt:disabledSites"].newValue || [];
    }
  });

  // Is the store for the current page paused by the user?
  function isSiteDisabled(domain) {
    const list = settings.disabledSites || [];
    return list.includes(domain) || list.includes(rootDomain);
  }

  // Let the popup ask which store this page resolves to, so it shows the same
  // merchant the on-page card uses — even behind a hosted checkout.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "cohunt:get-domain") return;
    const m = huntDomain || resolveMerchant();
    sendResponse({ domain: m || null, pos: isPOS(location.hostname) });
    return true;
  });

  // -- Selectors --------------------------------------------------------------
  const COUPON_INPUT_SELECTORS = [
    'input[name*="coupon" i]',
    'input[id*="coupon" i]',
    'input[placeholder*="coupon" i]',
    'input[name*="promo" i]',
    'input[id*="promo" i]',
    'input[placeholder*="promo" i]',
    'input[name*="discount" i]',
    'input[id*="discount" i]',
    'input[placeholder*="discount" i]',
    'input[name*="voucher" i]',
    'input[id*="voucher" i]',
    'input[placeholder*="voucher" i]',
    'input[name*="giftcard" i][name*="code" i]',
    'input[aria-label*="promo" i]',
    'input[aria-label*="coupon" i]',
    'input[aria-label*="discount" i]',
  ];

  const TOTAL_SELECTORS = [
    '[data-test*="total" i]',
    '[data-testid*="total" i]',
    '[class*="grand-total" i]',
    '[class*="grandtotal" i]',
    '[class*="order-total" i]',
    '[class*="ordertotal" i]',
    '[class*="cart-total" i]',
    '[id*="grand-total" i]',
    '[id*="order-total" i]',
  ];

  // Hidden gems: codes the merchant advertises on the page itself (banners,
  // popups, "use code SUMMER20 at checkout"). Text matching lives in core.js;
  // here we add the codes stashed in data-* attributes too.
  function scanPageForCodes() {
    const text = (document.body && document.body.innerText) || "";
    const byCode = new Map();
    for (const c of CHCore.scanCodesFromText(text)) byCode.set(c.code, c);
    document
      .querySelectorAll(
        "[data-promo-code],[data-coupon-code],[data-discount-code],[data-code]"
      )
      .forEach((el) => {
        const raw =
          el.getAttribute("data-promo-code") ||
          el.getAttribute("data-coupon-code") ||
          el.getAttribute("data-discount-code") ||
          el.getAttribute("data-code");
        const code = String(raw || "").toUpperCase();
        if (isGoodCode(code) && !byCode.has(code)) {
          byCode.set(code, { code, source: "On this page", onPage: true });
        }
      });
    return [...byCode.values()];
  }
  let lastPageCodes = [];

  function findCouponInput() {
    for (const sel of COUPON_INPUT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  }

  // Decide whether an element is a safe coupon-apply button. The text
  // classification (and the hard "never click pay/order" rule) is in core.js.
  function isApplyButton(el) {
    const t = (
      el.innerText ||
      el.value ||
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      ""
    ).trim();
    if (!t || t.length > 40) {
      // Icon-only / headless buttons: trust explicit test hooks, but still
      // refuse anything order/pay related.
      const dt = (
        el.getAttribute("data-test") ||
        el.getAttribute("data-testid") ||
        ""
      ).toLowerCase();
      return /apply|redeem/.test(dt) && !/order|pay|checkout|purchase/.test(dt);
    }
    return classifyButtonLabel(t) === "apply";
  }

  function findApplyButton(near) {
    if (!near) return null;
    const seen = new Set();
    const candidates = [];
    const collect = (root) => {
      if (!root) return;
      for (const el of root.querySelectorAll(
        "button, input[type=submit], input[type=button], a[role=button], a"
      )) {
        if (!seen.has(el)) {
          seen.add(el);
          candidates.push(el);
        }
      }
    };
    // Nearest-first: climb the input's ancestors, then fall back to its form.
    let p = near.parentElement;
    for (let i = 0; i < 5 && p; i++) {
      collect(p);
      p = p.parentElement;
    }
    collect(near.closest("form"));
    for (const el of candidates) {
      if (el.offsetParent === null) continue; // skip hidden
      if (isApplyButton(el)) return el;
    }
    return null;
  }

  // Enter-to-apply is only safe when the coupon field's form can't place an order.
  function canPressEnter(input) {
    const form = input.closest("form");
    if (!form) return true;
    for (const b of form.querySelectorAll("button, input[type=submit]")) {
      const t = (b.innerText || b.value || b.getAttribute("aria-label") || "").trim();
      if (isDangerButtonText(t)) return false;
    }
    return true;
  }

  function readOrderTotal() {
    for (const sel of TOTAL_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) {
        const v = parseMoney(el.innerText);
        if (v != null) return v;
      }
    }
    return null;
  }

  // -- UI ---------------------------------------------------------------------
  const card = document.createElement("div");
  card.id = "cohunt-card";
  card.setAttribute("data-cohunt", "1");
  card.innerHTML = `
    <div class="cohunt-card-inner">
      <header class="cohunt-head">
        <div class="cohunt-brand">
          <span class="cohunt-spark">✦</span>
          <span class="cohunt-title">Coupon Hunter</span>
        </div>
        <button class="cohunt-close" aria-label="Close">×</button>
      </header>

      <div class="cohunt-stats">
        <div class="cohunt-stat">
          <div class="cohunt-stat-value cohunt-saved" data-cohunt-saved>$0.00</div>
          <div class="cohunt-stat-label">Saved so far</div>
        </div>
        <div class="cohunt-stat">
          <div class="cohunt-stat-value" data-cohunt-applied>0</div>
          <div class="cohunt-stat-label">Working codes</div>
        </div>
      </div>

      <div class="cohunt-meta">
        <span class="cohunt-domain" data-cohunt-domain></span>
        <span class="cohunt-status" data-cohunt-status>Looking around…</span>
      </div>

      <ul class="cohunt-list" data-cohunt-list></ul>

      <div class="cohunt-foot">
        <button class="cohunt-apply" data-cohunt-apply>Auto-apply best code</button>
        <button class="cohunt-refresh" data-cohunt-refresh title="Re-scan" aria-label="Re-scan">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M13.65 2.35a8 8 0 1 0 1.85 8.4l-1.6-.7a6.3 6.3 0 1 1-1.5-7.1L9.5 5.5H15V0Z" fill="currentColor"/></svg>
        </button>
      </div>
    </div>
  `;
  card.style.display = "none";
  document.documentElement.appendChild(card);

  const $ = (sel) => card.querySelector(sel);
  $(".cohunt-close").addEventListener("click", () => hideCard());
  $("[data-cohunt-refresh]").addEventListener("click", () => startHunt({ force: true }));
  $("[data-cohunt-apply]").addEventListener("click", () => autoApplyLoop());

  function showCard() {
    card.style.display = "block";
  }
  function hideCard() {
    card.style.display = "none";
  }
  function setStatus(s) {
    $("[data-cohunt-status]").textContent = s;
  }
  function setDomain(d) {
    $("[data-cohunt-domain]").textContent = d;
  }
  function setStats(saved, working) {
    const s = $("[data-cohunt-saved]");
    const w = $("[data-cohunt-applied]");
    if (s) s.textContent = `$${(saved || 0).toFixed(2)}`;
    if (w) w.textContent = String(working || 0);
  }

  let currentCodes = [];
  let attempted = new Map(); // code -> "working"|"failed"|"trying"

  function renderList() {
    const list = $("[data-cohunt-list]");
    list.innerHTML = "";
    if (!currentCodes.length) {
      list.innerHTML = `<li class="cohunt-empty">No codes yet. We'll keep searching.</li>`;
      return;
    }
    for (const c of currentCodes.slice(0, 12)) {
      const state = attempted.get(c.code) || "idle";
      const li = document.createElement("li");
      li.className = `cohunt-item cohunt-${state}`;
      li.innerHTML = `
        <code class="cohunt-code">${c.code}</code>
        <span class="cohunt-source">${c.source || ""}</span>
        <span class="cohunt-state">${
          state === "working"
            ? "Saved ✓"
            : state === "failed"
            ? "Invalid"
            : state === "trying"
            ? "Trying…"
            : ""
        }</span>
      `;
      li.querySelector(".cohunt-code").addEventListener("click", () => {
        navigator.clipboard?.writeText(c.code);
        setStatus(`Copied ${c.code}`);
      });
      list.appendChild(li);
    }
  }

  // -- Hunt orchestration ------------------------------------------------------
  function startHunt({ force = false } = {}) {
    huntDomain = resolveMerchant();
    if (!huntDomain) {
      // Hosted checkout we couldn't attribute to a store. Do NOT hunt — better
      // to apply nothing than to apply another shop's codes.
      if (settings.floatCard) showCard();
      setDomain(location.hostname.replace(/^www\./, ""));
      setStatus(
        "Hosted checkout detected — couldn't identify the store, so no codes will be applied."
      );
      return;
    }
    setStatus("Hunting the web for the best deal…");
    setDomain(
      isPOS(location.hostname) ? `${huntDomain} · via checkout` : huntDomain
    );
    if (settings.floatCard) showCard();
    retryPending = false;
    // Hidden gems the merchant advertises on this very page.
    lastPageCodes = scanPageForCodes();
    chrome.runtime.sendMessage(
      { type: "hunt", domain: huntDomain, force },
      (res) => {
        if (!res?.ok) {
          // Still try whatever the page itself advertised.
          currentCodes = mergeCodes(lastPageCodes);
          onCodesResolved();
          return;
        }
        currentCodes = mergeCodes(lastPageCodes, res.codes || []);
        chrome.runtime
          .sendMessage({ type: "open-popup", count: currentCodes.length })
          .catch(() => {});
        onCodesResolved();
      }
    );
  }

  // Codes are scoped to this exact store: on-page codes + codes the DBs list
  // for huntDomain. Generated/common guesses are filtered out in mergeCodes,
  // so we only ever try real coupons found for the site you're on.
  function onCodesResolved() {
    renderList();
    if (currentCodes.length) {
      retryAttempts = 0;
      retryPending = false;
      clearTimeout(retryTimer);
      setStatus(
        `Found ${currentCodes.length} code${
          currentCodes.length > 1 ? "s" : ""
        } for ${huntDomain}.`
      );
      maybeAutoApply();
    } else {
      scheduleRetryHunt();
    }
  }

  // Keep searching until real codes turn up for this specific store (handles
  // DBs being briefly down, or the merchant's on-page code loading late).
  let retryAttempts = 0;
  let retryPending = false;
  let retryTimer = null;
  const MAX_RETRIES = 6;
  function scheduleRetryHunt() {
    if (retryPending) return;
    if (retryAttempts >= MAX_RETRIES) {
      setStatus(`No codes found for ${huntDomain} yet — click ↻ to keep looking.`);
      return;
    }
    retryAttempts++;
    retryPending = true;
    const delay = Math.min(3000 * retryAttempts, 20000);
    setStatus(
      `No codes yet for ${huntDomain} — searching again (${retryAttempts}/${MAX_RETRIES})…`
    );
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryPending = false;
      startHunt({ force: true });
    }, delay);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "hunt-progress") return;
    if (msg.domain !== huntDomain) return; // only our resolved store
    if (msg.phase === "source-done") {
      setStatus(`Checked ${msg.source} — ${msg.found} hits.`);
    } else if (msg.phase === "starting") {
      setStatus(`Scanning ${msg.sources?.length || 0} coupon databases…`);
    } else if (msg.phase === "complete") {
      currentCodes = mergeCodes(lastPageCodes, msg.codes || []);
      onCodesResolved();
    }
  });

  // -- Apply loop --------------------------------------------------------------
  // Runs itself once codes land, no user click required. Guarded so it fires
  // exactly once per page load and only when there's actually a field to fill.
  let autoApplied = false;
  let applyInFlight = false;
  function maybeAutoApply() {
    if (!settings.autoApply || autoApplied || applyInFlight) return;
    if (!currentCodes.length || !findCouponInput()) return;
    autoApplied = true;
    autoApplyLoop();
  }

  function getResultsLog() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "get-results-log", domain: huntDomain },
        (r) => resolve(r?.log || {})
      );
    });
  }

  async function autoApplyLoop() {
    const input = findCouponInput();
    if (!input) {
      setStatus("No coupon field found on this page yet.");
      return;
    }
    if (!currentCodes.length) {
      setStatus("Nothing to try yet.");
      return;
    }
    if (applyInFlight) return;
    applyInFlight = true;
    try {
      // Order by POTENTIAL savings (biggest first) so the likely winners are
      // tried up front — but EVERY code still gets tried, nothing is skipped.
      //   * proven winners (saved real money here before) go first, by amount
      //   * otherwise estimate the discount from the digits in the code
      //     (SAVE40 -> 40, WELCOME10 -> 10, FREESHIP -> 0)
      //   * ties broken by trust: on-page > listed DB > generated guess
      const log = await getResultsLog();
      const potential = (c) => {
        const r = log[c.code];
        if (r?.status === "working" && r.savings) return 1000 + r.savings;
        return potentialFromCode(c.code);
      };
      const trust = (c) => (c.onPage ? 0 : c.generated ? 2 : 1);
      // Dedupe + drop junk one more time, then try ALL of them (no cap).
      const seen = new Set();
      const queue = [...currentCodes]
        .filter((c) => isGoodCode(c.code) && !seen.has(c.code) && seen.add(c.code))
        .sort((a, b) => potential(b) - potential(a) || trust(a) - trust(b));

      if (settings.floatCard) showCard();
      const baseline = readOrderTotal();

      // suffixCeil[i] = the most any code from position i onward could save
      // (upper bound used for the provably-worse early exit; see CHCore).
      const suffixCeil = new Array(queue.length + 1).fill(0);
      for (let i = queue.length - 1; i >= 0; i--) {
        suffixCeil[i] = Math.max(
          suffixCeil[i + 1],
          ceilSavings(queue[i].code, baseline)
        );
      }

      // Track the lowest total any code produced — that's the absolute best.
      let best = null; // { code, savings }
      let bestTotal = baseline == null ? Infinity : baseline;
      let workingCount = 0;
      setStats(0, 0);
      for (let i = 0; i < queue.length; i++) {
        const c = queue[i];
        const field = findCouponInput();
        if (!field) break; // checkout advanced / field vanished — stop safely

        // Provably-worse early exit: if what we've already banked beats the most
        // any remaining code could yield, there's nothing left worth trying.
        if (
          baseline != null &&
          best &&
          best.savings != null &&
          best.savings + 0.01 >= suffixCeil[i]
        ) {
          setStatus(
            `Done early — ${best.code} saves $${best.savings.toFixed(
              2
            )}; no remaining code could beat it.`
          );
          break;
        }

        // Make sure the previous code has fully settled before typing the next
        // one — never stack two codes into the field while the merchant is
        // still processing.
        await settleBusy();
        attempted.set(c.code, "trying");
        renderList();
        setStatus(`Trying ${c.code}… (${i + 1} of ${queue.length})`);
        const result = await tryCode(field, c.code, baseline);

        // Never skip the rest — try every code. (A rate-limit signal just
        // counts as a failed attempt and we keep going.)
        attempted.set(c.code, result.success ? "working" : "failed");
        renderList();
        chrome.runtime
          .sendMessage({
            type: "record-result",
            domain: huntDomain,
            code: c.code,
            status: result.success ? "working" : "failed",
            savings: result.savings,
          })
          .catch(() => {});

        if (result.success) {
          workingCount++;
          const total =
            baseline != null && result.savings != null
              ? baseline - result.savings
              : null;
          if (total != null && total < bestTotal - 0.01) {
            bestTotal = total;
            best = { code: c.code, savings: result.savings };
          } else if (!best) {
            best = { code: c.code, savings: result.savings };
          }
          setStats(best ? best.savings : 0, workingCount);
        }
        // Human-ish pause between codes — varies so it isn't a robotic burst.
        await sleep(INTER_CODE_DELAY_MS + Math.floor(Math.random() * 350));
      }

      if (best) {
        // Re-apply the winner so checkout keeps the biggest discount.
        const field = findCouponInput();
        if (field) await tryCode(field, best.code, baseline);
        setStats(best.savings, workingCount);
        setStatus(
          best.savings
            ? `All done — ${best.code} saved you $${best.savings.toFixed(2)} 🎉`
            : `All done — applied ${best.code}.`
        );
      } else {
        // Never leave a junk code in the box — clear it back out.
        clearCouponField();
        setStatus("No working code this time — cleared the box for you.");
      }
    } finally {
      applyInFlight = false;
    }
  }

  const INTER_CODE_DELAY_MS = 700;

  function clearCouponField() {
    const field = findCouponInput();
    if (!field) return;
    setNativeValue(field, "");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Type a code the way a person would: focus, clear, then key it in one
  // character at a time with small irregular pauses and real keyboard events.
  async function humanType(input, text) {
    try {
      input.focus();
    } catch {}
    setNativeValue(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    let acc = "";
    for (const ch of text) {
      acc += ch;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
      setNativeValue(input, acc);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      await sleep(35 + Math.random() * 55); // ~35–90ms per keystroke
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function tryCode(input, code, baseline) {
    await humanType(input, code);
    const apply = findApplyButton(input);
    if (apply) {
      apply.click();
    } else if (canPressEnter(input)) {
      // No safe apply button — submit the field with Enter (only when the
      // surrounding form can't place an order).
      for (const type of ["keydown", "keypress", "keyup"]) {
        input.dispatchEvent(
          new KeyboardEvent(type, {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
          })
        );
      }
    }
    // Give the merchant a moment to start processing, then wait for a verdict.
    await sleep(150);
    return waitForResult(baseline);
  }

  // True while the checkout is visibly validating (spinner / loading state).
  // We must not declare a result or type the next code until this clears.
  function isBusy() {
    const el = document.querySelector(
      '[aria-busy="true"], [role="progressbar"], [class*="spinner" i], [class*="loading" i], [class*="loader" i]'
    );
    return !!(el && el.offsetParent !== null);
  }

  async function settleBusy(maxMs = 6000) {
    const start = Date.now();
    while (isBusy() && Date.now() - start < maxMs) {
      await sleep(200);
    }
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  // Resolve {success, savings, rateLimited} only on a DEFINITIVE verdict — a
  // real discount, or the merchant's own "invalid" message (both of which only
  // appear after the spinner finishes). We never declare a result off a
  // mid-processing flicker, and we keep waiting while the page is still busy.
  // The text classification lives in core.js (classifyResultText).
  function waitForResult(baseline, timeoutMs = 3500) {
    return new Promise((resolve) => {
      const start = Date.now();
      const HARD_CAP = Math.max(timeoutMs, 8000);
      const tick = () => {
        const total = readOrderTotal();
        const verdict = classifyResultText(
          (document.body && document.body.innerText) || ""
        );

        if (verdict === "ratelimit") {
          return resolve({ success: false, rateLimited: true });
        }
        // A real discount: total dropped below the no-code baseline.
        if (total != null && baseline != null && total < baseline - 0.01) {
          return resolve({ success: true, savings: baseline - total });
        }
        // The merchant explicitly rejected the code.
        if (verdict === "invalid") {
          return resolve({ success: false });
        }
        // Success message with a non-increasing total (e.g. free-shipping codes
        // that don't move the subtotal line we read).
        if (
          verdict === "success" &&
          total != null &&
          baseline != null &&
          total <= baseline + 0.01
        ) {
          return resolve({ success: true, savings: Math.max(0, baseline - total) });
        }

        const elapsed = Date.now() - start;
        // Only give up once we're past the timeout AND the page has stopped
        // processing — so a slow checkout always gets to finish validating.
        if ((elapsed > timeoutMs && !isBusy()) || elapsed > HARD_CAP) {
          if (total != null && baseline != null && total < baseline - 0.01) {
            return resolve({ success: true, savings: baseline - total });
          }
          return resolve({ success: false });
        }
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // -- Trigger (fully automatic) ----------------------------------------------
  // Fires once per page as soon as a coupon field exists and settings are
  // known. The hunt → auto-apply chain then runs with zero user interaction.
  let autoHuntTriggered = false;
  function autoTrigger() {
    if (!settingsLoaded || autoHuntTriggered) return;
    if (!settings.enabled) return; // master off
    if (!settings.autoHunt) return;
    if (!findCouponInput()) return;
    // On a hosted checkout, wait until we can actually attribute the store
    // (referrer or page fills in). Until then, keep watching — never hunt the
    // processor's own domain.
    const merchant = resolveMerchant();
    if (!merchant) return;
    if (isSiteDisabled(merchant)) return; // user paused this store
    autoHuntTriggered = true;
    startHunt();
  }

  // Single-page checkouts mount the coupon field late — keep watching for it.
  const mo = new MutationObserver(autoTrigger);
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // The popup can force a hunt/apply regardless of the auto settings.
  window.addEventListener("message", (e) => {
    if (e.data?.type === "cohunt:open") startHunt();
  });
})();
