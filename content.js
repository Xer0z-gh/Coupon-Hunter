// Coupon Hunter — content script.
// Runs on every page. When it spots a coupon-code input it:
//   1. Asks the background worker for codes for the current domain.
//   2. Presents a floating card on the page (collapsible to a pill).
//   3. Auto-applies codes via the page's own apply button, watching the order
//      total, and keeps whichever code saves the most.

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
    buildApplyQueue,
    suffixCeilings,
  } = CHCore;
  const rootDomain = rootDomainOf(location.hostname);

  // -- Safe extension-API layer ------------------------------------------------
  // When the extension is reloaded/updated, content scripts in already-open
  // tabs keep running but every chrome.* call starts throwing "Extension
  // context invalidated". Everything below goes through this layer so a dead
  // context stops the machinery quietly instead of spraying uncaught errors.
  let dead = false;
  let mo = null; // MutationObserver, assigned at the bottom
  let retryTimer = null;
  let collapseTimer = null;

  function alive() {
    try {
      return !dead && !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function markDead() {
    if (dead) return;
    dead = true;
    try { mo && mo.disconnect(); } catch {}
    clearTimeout(retryTimer);
    clearTimeout(collapseTimer);
    try {
      setStatus("Coupon Hunter was updated — reload this page to keep hunting.");
    } catch {}
  }

  // Fire-and-forget or request/response — never throws, never rejects.
  // Resolves null when the background can't be reached.
  function safeSend(msg) {
    return new Promise((resolve) => {
      if (!alive()) {
        markDead();
        return resolve(null);
      }
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          // Reading lastError marks the error as handled (no console spam).
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res ?? null);
        });
      } catch {
        markDead();
        resolve(null);
      }
    });
  }

  // -- Third-party checkout / POS detection -----------------------------------
  // On hosted checkouts (Shop Pay, Stripe, PayPal, Square, Klarna, etc.) the
  // page's own domain is the PROCESSOR, not the store. We resolve the REAL
  // merchant the cart belongs to and hunt + apply for that domain only.
  function resolveMerchant() {
    const here = location.hostname.toLowerCase().replace(/^www\./, "");
    if (!isPOS(here)) return rootDomainOf(here);
    try {
      if (document.referrer) {
        const rh = new URL(document.referrer).hostname;
        if (rh && !isPOS(rh)) return rootDomainOf(rh);
      }
    } catch {}
    return CHCore.guessMerchantFromHtml(document.documentElement.outerHTML || "");
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
  try {
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
  } catch {
    settingsLoaded = true;
  }

  // Is the store for the current page paused by the user?
  function isSiteDisabled(domain) {
    const list = settings.disabledSites || [];
    return list.includes(domain) || list.includes(rootDomain);
  }

  // Let the popup ask which store this page resolves to, so it shows the same
  // merchant the on-page card uses — even behind a hosted checkout.
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "cohunt:get-domain") {
        const m = huntDomain || resolveMerchant();
        sendResponse({ domain: m || null, pos: isPOS(location.hostname) });
        return true;
      }
      if (msg?.type === "hunt-progress") {
        onHuntProgress(msg);
      }
      // Keyboard shortcut (or popup) → force a hunt/apply right now.
      if (msg?.type === "cohunt:trigger") {
        startHunt({ force: true });
      }
    });
  } catch {}

  // -- Selectors --------------------------------------------------------------
  // One combined selector → one DOM pass. Includes the words checkouts use for
  // a coupon field across major languages, so it works far beyond US stores.
  // (English, German, French, Spanish, Portuguese, Italian, Dutch, Nordic.)
  const COUPON_TERMS = [
    "coupon",
    "promo",
    "discount",
    "voucher",
    "gutschein", // de
    "rabatt", // de/sv/no
    "descuento", // es
    "cupon", // es
    "cupom", // pt
    "desconto", // pt
    "sconto", // it
    "buono", // it
    "korting", // nl
    "kupon", // pl
    "reduction", // fr (réduction)
  ];
  const COUPON_INPUT_SELECTOR = COUPON_TERMS.flatMap((t) => [
    `input[name*="${t}" i]`,
    `input[id*="${t}" i]`,
    `input[placeholder*="${t}" i]`,
    `input[aria-label*="${t}" i]`,
  ])
    .concat('input[name*="giftcard" i][name*="code" i]')
    .join(",");

  const TOTAL_SELECTOR = [
    '[data-test*="total" i]',
    '[data-testid*="total" i]',
    '[class*="grand-total" i]',
    '[class*="grandtotal" i]',
    '[class*="order-total" i]',
    '[class*="ordertotal" i]',
    '[class*="cart-total" i]',
    '[id*="grand-total" i]',
    '[id*="order-total" i]',
  ].join(",");

  function findCouponInput() {
    for (const el of document.querySelectorAll(COUPON_INPUT_SELECTOR)) {
      if (el.offsetParent !== null) return el;
    }
    return null;
  }

  function readOrderTotal() {
    for (const el of document.querySelectorAll(TOTAL_SELECTOR)) {
      const v = parseMoney(el.innerText);
      if (v != null) return v;
    }
    return null;
  }

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

  // -- UI ---------------------------------------------------------------------
  const card = document.createElement("div");
  card.id = "cohunt-card";
  card.setAttribute("data-cohunt", "1");
  card.innerHTML = `
    <button class="cohunt-pill" data-cohunt-pill hidden>
      <span class="cohunt-spark">✦</span>
      <span data-cohunt-pill-text>Coupon Hunter</span>
    </button>
    <div class="cohunt-card-inner">
      <header class="cohunt-head">
        <div class="cohunt-brand">
          <span class="cohunt-spark">✦</span>
          <span class="cohunt-title">Coupon Hunter</span>
        </div>
        <div class="cohunt-head-actions">
          <button class="cohunt-minimize" aria-label="Minimize" title="Minimize">–</button>
          <button class="cohunt-close" aria-label="Close">×</button>
        </div>
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

      <div class="cohunt-progress" data-cohunt-progress hidden>
        <div class="cohunt-progress-fill" data-cohunt-progress-fill></div>
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
  $(".cohunt-minimize").addEventListener("click", () => collapseCard());
  $("[data-cohunt-pill]").addEventListener("click", () => expandCard());
  $("[data-cohunt-refresh]").addEventListener("click", () => startHunt({ force: true }));
  $("[data-cohunt-apply]").addEventListener("click", () => autoApplyLoop());

  function showCard() {
    card.style.display = "block";
  }
  function hideCard() {
    card.style.display = "none";
  }
  function collapseCard(pillText) {
    clearTimeout(collapseTimer);
    if (pillText) $("[data-cohunt-pill-text]").textContent = pillText;
    card.classList.add("cohunt-collapsed");
    $("[data-cohunt-pill]").hidden = false;
  }
  function expandCard() {
    clearTimeout(collapseTimer);
    card.classList.remove("cohunt-collapsed");
    $("[data-cohunt-pill]").hidden = true;
  }
  // After a final state, tuck the card away into an unobtrusive pill.
  function autoCollapseSoon(pillText, ms = 8000) {
    clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => collapseCard(pillText), ms);
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
    if (s) {
      const next = `$${(saved || 0).toFixed(2)}`;
      if (s.textContent !== next) {
        s.textContent = next;
        s.classList.remove("cohunt-pop");
        void s.offsetWidth; // restart the pop animation
        s.classList.add("cohunt-pop");
      }
    }
    if (w) w.textContent = String(working || 0);
  }
  function setProgress(done, total) {
    const bar = $("[data-cohunt-progress]");
    const fill = $("[data-cohunt-progress-fill]");
    if (!total) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    fill.style.width = `${Math.round((done / total) * 100)}%`;
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
        <code class="cohunt-code"></code>
        <span class="cohunt-source"></span>
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
      li.querySelector(".cohunt-code").textContent = c.code;
      // Show cross-source consensus ("CouponFollow +3") — corroborated codes
      // are far likelier to work.
      const extra = c.sourceCount > 1 ? ` +${c.sourceCount - 1}` : "";
      li.querySelector(".cohunt-source").textContent = (c.source || "") + extra;
      li.querySelector(".cohunt-code").addEventListener("click", () => {
        navigator.clipboard?.writeText(c.code);
        setStatus(`Copied ${c.code}`);
      });
      list.appendChild(li);
    }
  }

  // -- Hunt orchestration ------------------------------------------------------
  function startHunt({ force = false } = {}) {
    if (dead) return;
    expandCard();
    card.classList.remove("cohunt-success");
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
    safeSend({ type: "hunt", domain: huntDomain, force }).then((res) => {
      if (dead) return;
      if (!res?.ok) {
        // Background unreachable — still try whatever the page itself advertised.
        currentCodes = mergeCodes(lastPageCodes);
        onCodesResolved();
        return;
      }
      currentCodes = mergeCodes(lastPageCodes, res.codes || []);
      safeSend({ type: "open-popup", count: currentCodes.length });
      onCodesResolved();
    });
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
  const MAX_RETRIES = 6;
  function scheduleRetryHunt() {
    if (retryPending || dead) return;
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

  function onHuntProgress(msg) {
    if (dead) return;
    if (msg.domain !== huntDomain) return; // only our resolved store
    if (msg.phase === "source-done") {
      setStatus(`Checked ${msg.source} — ${msg.found} hits.`);
    } else if (msg.phase === "starting") {
      setStatus(`Scanning ${msg.sources?.length || 0} coupon databases…`);
    } else if (msg.phase === "complete") {
      currentCodes = mergeCodes(lastPageCodes, msg.codes || []);
      onCodesResolved();
    }
  }

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
    if (applyInFlight || dead) return;
    applyInFlight = true;
    try {
      // Try-order and early-exit bounds are pure logic — see core.js.
      const logRes = await safeSend({ type: "get-results-log", domain: huntDomain });

      if (settings.floatCard) showCard();
      expandCard();
      const baseline = readOrderTotal();
      // Order by expected savings (proven > advertised discount > guess), using
      // the live cart total to turn "20% off" into real dollars.
      const queue = buildApplyQueue(currentCodes, logRes?.log || {}, baseline);
      const suffixCeil = suffixCeilings(queue, baseline);

      // Track the lowest total any code produced — that's the absolute best.
      let best = null; // { code, savings }
      let bestTotal = baseline == null ? Infinity : baseline;
      let workingCount = 0;
      let tested = 0;
      setStats(0, 0);
      setProgress(0, queue.length);
      for (let i = 0; i < queue.length && !dead; i++) {
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
        tested++;
        setProgress(i + 1, queue.length);

        // Never skip the rest — try every code. (A rate-limit signal just
        // counts as a failed attempt and we keep going.)
        attempted.set(c.code, result.success ? "working" : "failed");
        renderList();
        safeSend({
          type: "record-result",
          domain: huntDomain,
          code: c.code,
          status: result.success ? "working" : "failed",
          savings: result.savings,
        });

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
      setProgress(0, 0);

      if (best) {
        // Re-apply the winner so checkout keeps the biggest discount.
        const field = findCouponInput();
        if (field && !dead) await tryCode(field, best.code, baseline);
        setStats(best.savings, workingCount);
        card.classList.add("cohunt-success");
        if (best.savings) {
          setStatus(`All done — ${best.code} saved you $${best.savings.toFixed(2)} 🎉`);
          autoCollapseSoon(`✓ Saved $${best.savings.toFixed(2)}`);
        } else {
          setStatus(`All done — applied ${best.code}.`);
          autoCollapseSoon(`✓ ${best.code} applied`);
        }
      } else {
        // Never leave a junk code in the box — clear it back out.
        clearCouponField();
        // The Honey-style reassurance: a clean "nothing left on the table".
        setStatus(
          tested > 0
            ? `We tested ${tested} code${tested > 1 ? "s" : ""} — you already have the best price. ✓`
            : "No working code this time — cleared the box for you."
        );
        autoCollapseSoon("✓ Best price");
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
    return waitForResult(input, baseline);
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

  // Where the merchant prints "applied"/"invalid" — usually near the coupon
  // field. Reading that region is far cheaper than document.body.innerText on
  // a big checkout, so we read the scoped text every tick and the full body
  // only every other tick (some sites toast at the top of the page).
  function verdictScopeFor(input) {
    if (!input) return null;
    let scope = input.closest("form");
    if (!scope) {
      scope = input.parentElement;
      for (let i = 0; i < 3 && scope && scope.parentElement; i++) {
        scope = scope.parentElement;
      }
    }
    return scope;
  }

  // Resolve {success, savings, rateLimited} only on a DEFINITIVE verdict — a
  // real discount, or the merchant's own "invalid" message (both of which only
  // appear after the spinner finishes). We never declare a result off a
  // mid-processing flicker, and we keep waiting while the page is still busy.
  // The text classification lives in core.js (classifyResultText).
  function waitForResult(input, baseline, timeoutMs = 3500) {
    const scope = verdictScopeFor(input);
    return new Promise((resolve) => {
      const start = Date.now();
      const HARD_CAP = Math.max(timeoutMs, 8000);
      let ticks = 0;
      const tick = () => {
        ticks++;
        const total = readOrderTotal();
        let verdict = classifyResultText((scope && scope.innerText) || "");
        if (!verdict && (ticks % 2 === 0 || !scope)) {
          verdict = classifyResultText(
            (document.body && document.body.innerText) || ""
          );
        }

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
    if (!settingsLoaded || autoHuntTriggered || dead) return;
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
    if (mo) mo.disconnect(); // one-shot — no need to keep watching the DOM
    startHunt();
  }

  // Single-page checkouts mount the coupon field late — keep watching for it,
  // but debounce: checkout pages mutate constantly and the field check isn't
  // free. One trailing check per 200ms burst is plenty.
  let moTimer = null;
  mo = new MutationObserver(() => {
    if (autoHuntTriggered || dead) {
      mo.disconnect();
      return;
    }
    clearTimeout(moTimer);
    moTimer = setTimeout(autoTrigger, 200);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // The popup can force a hunt/apply regardless of the auto settings.
  window.addEventListener("message", (e) => {
    if (e.data?.type === "cohunt:open") startHunt();
  });
})();
