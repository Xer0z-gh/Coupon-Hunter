// Popup logic. Talks to background.js via chrome.runtime messages.
const $ = (id) => document.getElementById(id);

const state = {
  domain: null, // resolved store for the active tab
  tabId: null,
  scanDomain: null, // domain currently being scanned (Scan tab)
  scanSources: 0,
  scanDone: 0,
};

function rootDomain(host) {
  if (!host) return null;
  let h = host.toLowerCase().replace(/^www\./, "");
  const p = h.split(".");
  if (p.length < 3) return h;
  return /\.(co|com|org|gov|ac|net)\.[a-z]{2}$/.test(h) ? p.slice(-3).join(".") : p.slice(-2).join(".");
}
function send(msg) {
  return new Promise((res) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        void chrome.runtime.lastError;
        res(r || null);
      });
    } catch {
      res(null);
    }
  });
}
function resolveTabDomain(tabId) {
  return new Promise((res) => {
    if (!tabId) return res(null);
    try {
      chrome.tabs.sendMessage(tabId, { type: "cohunt:get-domain" }, (r) => {
        void chrome.runtime.lastError;
        res(r || null);
      });
    } catch {
      res(null);
    }
  });
}
function setMeta(t) { $("footerMeta").textContent = t; }

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab?.id;
  let host = null;
  try { host = new URL(tab.url).hostname; } catch {}
  const fallback = rootDomain(host);

  const resolved = await resolveTabDomain(state.tabId);
  state.domain = (resolved && resolved.domain) || fallback || null;

  const label = state.domain || "this site";
  $("applyDomain").textContent = label;
  $("addDomain").textContent = label;
  $("pauseDomain").textContent = label;
  $("scanDomain").value = state.domain || "";

  loadSavings();
  loadSiteState();
  loadSettings();
  loadAppliedCodes();
  loadMyCodes();
}

// ---------------------------------------------------------------------------
// Savings hero + recent wins
// ---------------------------------------------------------------------------
async function loadSavings() {
  const r = await send({ type: "get-savings" });
  if (!r?.ok) return;
  $("savingsTotal").textContent = `$${(r.total || 0).toFixed(2)}`;
  $("savingsCount").textContent = r.count || 0;
  $("savingsStores").textContent = r.stores || 0;
  const wins = (r.history || []).filter((h) => h && h.savings > 0).slice(0, 5);
  $("wins").hidden = wins.length === 0;
  const wrap = $("winsList");
  wrap.innerHTML = "";
  for (const w of wins) {
    const row = document.createElement("div");
    row.className = "win-row";
    row.innerHTML = `<span class="win-store"></span><code class="win-code"></code><span class="win-amt"></span>`;
    row.querySelector(".win-store").textContent = w.domain || "";
    row.querySelector(".win-code").textContent = w.code || "";
    row.querySelector(".win-amt").textContent = `–$${(w.savings || 0).toFixed(2)}`;
    wrap.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Shared code-row rendering
// ---------------------------------------------------------------------------
function sourceLabel(c) {
  const extra = c.sourceCount > 1 ? ` +${c.sourceCount - 1}` : "";
  return (c.source || "") + extra;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Row layout: clickable code · source/consensus · crowd badge (if any).
function renderCodeList(container, codes, emptyMsg) {
  container.innerHTML = "";
  if (!codes || !codes.length) {
    if (emptyMsg) container.appendChild(el("div", "hint", emptyMsg));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const c of codes.slice(0, 60)) {
    const row = el("div", "row-item");
    const code = el("code", "row-code", c.code);
    code.title = "Click to copy";
    code.addEventListener("click", () => {
      navigator.clipboard?.writeText(c.code);
      setMeta(`Copied ${c.code}`);
    });
    row.append(code, el("span", "row-meta", sourceLabel(c)));
    const works = c.works || 0;
    const fails = c.fails || 0;
    if (works + fails > 0) {
      const badge = el("span", "row-badge");
      const rate = Math.round((works / (works + fails)) * 100);
      badge.innerHTML =
        '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M5 12.5l4.5 4.5L19 7"/></svg> ';
      badge.appendChild(document.createTextNode(`${rate}% · ${works}`));
      row.appendChild(badge);
    }
    frag.appendChild(row);
  }
  container.appendChild(frag);
}

// ---------------------------------------------------------------------------
// APPLY tab
// ---------------------------------------------------------------------------
async function loadAppliedCodes() {
  if (!state.domain) {
    $("applyHint").textContent = "No store detected on this page.";
    $("applyBtn").disabled = true;
    return;
  }
  const r = await send({ type: "get-cached", domain: state.domain });
  const codes = (r && r.codes) || [];
  renderCodeList($("applyList"), codes, "");
  $("applyHint").hidden = codes.length > 0;
  $("applyHint").textContent = codes.length
    ? ""
    : "No codes saved yet — use the Scan tab to find some.";
}
async function applyOnPage() {
  if (!state.tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: () => window.postMessage({ type: "cohunt:open" }, "*"),
    });
    setMeta("Applying on the page…");
    window.close();
  } catch {
    setMeta("Can't run on this page.");
  }
}

// ---------------------------------------------------------------------------
// SCAN tab
// ---------------------------------------------------------------------------
function startScan() {
  const domain = rootDomain($("scanDomain").value.trim());
  if (!domain) { setMeta("Enter a store domain first."); return; }
  state.scanDomain = domain;
  state.scanSources = 0;
  state.scanDone = 0;
  $("scanList").innerHTML = "";
  $("scanBar").hidden = false;
  $("scanFill").style.width = "6%";
  $("scanStatus").textContent = `Scanning the web for ${domain}…`;
  $("scanBtn").disabled = true;
  send({ type: "hunt", domain, force: true }).then((r) => {
    $("scanBtn").disabled = false;
    $("scanBar").hidden = true;
    if (!r?.ok) { $("scanStatus").textContent = "Scan failed — try again."; return; }
    const codes = r.codes || [];
    $("scanStatus").textContent = codes.length
      ? `Found ${codes.length} code${codes.length > 1 ? "s" : ""} for ${domain}.`
      : `No codes found for ${domain} yet.`;
    renderCodeList($("scanList"), codes, "");
  });
}

// ---------------------------------------------------------------------------
// ADD tab
// ---------------------------------------------------------------------------
async function loadMyCodes() {
  if (!state.domain) return;
  const r = await send({ type: "user-list", domain: state.domain });
  const codes = (r && r.codes) || [];
  $("myCodesLabel").hidden = codes.length === 0;
  const wrap = $("myCodes");
  wrap.innerHTML = "";
  for (const c of codes) {
    const row = document.createElement("div");
    row.className = "row-item";
    row.innerHTML = `<code class="row-code"></code><span class="row-meta"></span><button class="row-x" title="Remove">×</button>`;
    row.querySelector(".row-code").textContent = c.code;
    row.querySelector(".row-meta").textContent =
      c.pct ? `${c.pct}% off` : c.amount ? `$${c.amount} off` : c.freeShip ? "free ship" : "added";
    row.querySelector(".row-x").addEventListener("click", async () => {
      await send({ type: "user-remove", domain: state.domain, code: c.code });
      loadMyCodes();
    });
    wrap.appendChild(row);
  }
}
async function addCode() {
  const msgEl = $("addMsg");
  const code = $("addCode").value.toUpperCase().trim();
  if (!/^[A-Z0-9]{4,20}$/.test(code)) {
    msgEl.className = "add-msg err"; msgEl.textContent = "Enter a code (4–20 letters/numbers)."; return;
  }
  if (!state.domain) { msgEl.className = "add-msg err"; msgEl.textContent = "No store detected."; return; }
  const type = $("addType").value;
  const val = parseInt($("addValue").value, 10);
  const payload = { type: "user-add", domain: state.domain, code, share: $("addShare").checked };
  if (type === "pct" && val >= 1) payload.pct = Math.min(95, val);
  else if (type === "amount" && val >= 1) payload.amount = val;
  else if (type === "free") payload.freeShip = true;
  const r = await send(payload);
  if (r?.ok) {
    msgEl.className = "add-msg ok";
    msgEl.textContent = r.shared ? "Added and shared with the community." : "Added — it'll be tried first here.";
    $("addCode").value = ""; $("addValue").value = "";
    loadMyCodes();
  } else {
    msgEl.className = "add-msg err"; msgEl.textContent = "Couldn't add that code.";
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function loadSiteState() {
  if (!state.domain) return;
  send({ type: "get-site-state", domain: state.domain }).then((r) => {
    if (!r?.ok) return;
    $("optEnabled").checked = r.enabled !== false;
    $("optPauseSite").checked = !!r.siteDisabled;
  });
}
async function loadSettings() {
  const o = await chrome.storage.sync.get([
    "optAutoHunt", "optAutoApply", "optFloatCard", "optTtl", "optShareFeedback",
  ]);
  $("optAutoHunt").checked = o.optAutoHunt !== false;
  $("optAutoApply").checked = o.optAutoApply !== false;
  $("optFloatCard").checked = o.optFloatCard !== false;
  $("optShareFeedback").checked = o.optShareFeedback !== false;
  $("optTtl").value = o.optTtl || 1;
}
function bindSettings() {
  for (const id of ["optAutoHunt", "optAutoApply", "optFloatCard", "optShareFeedback"]) {
    $(id).addEventListener("change", (e) => chrome.storage.sync.set({ [id]: e.target.checked }));
  }
  $("optTtl").addEventListener("change", (e) => {
    const v = Math.max(1, Math.min(168, parseInt(e.target.value || "1", 10)));
    chrome.storage.sync.set({ optTtl: v }); e.target.value = v;
  });
  $("optEnabled").addEventListener("change", (e) =>
    send({ type: "set-enabled", enabled: e.target.checked }));
  $("optPauseSite").addEventListener("change", (e) => {
    send({ type: "set-site-enabled", domain: state.domain, enabled: !e.target.checked });
    setMeta(e.target.checked ? `Paused on ${state.domain}` : `Active on ${state.domain}`);
  });
  $("clearCache").addEventListener("click", async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("cohunt:cache:"));
    if (keys.length) await chrome.storage.local.remove(keys);
    setMeta("Cache cleared");
  });
  $("resetSavings").addEventListener("click", () =>
    send({ type: "reset-savings" }).then(() => { loadSavings(); setMeta("Savings reset"); }));
}

// ---------------------------------------------------------------------------
// Tabs + streaming progress
// ---------------------------------------------------------------------------
function switchTab(name) {
  const order = ["apply", "scan", "add"];
  const idx = order.indexOf(name);
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("is-active", t.dataset.tab === name));
  for (const p of order) $("panel-" + p).hidden = p !== name;
  $("tabIndicator").style.transform = `translateX(${idx * 100}%)`;
  if (name === "scan") $("scanDomain").focus();
  if (name === "add") $("addCode").focus();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "hunt-progress" || msg.domain !== state.scanDomain) return;
  if (msg.phase === "starting") {
    state.scanSources = msg.sources?.length || 0; state.scanDone = 0;
    $("scanFill").style.width = "8%";
  } else if (msg.phase === "source-done") {
    state.scanDone++;
    const pct = state.scanSources ? Math.round((state.scanDone / state.scanSources) * 92) + 8 : 50;
    $("scanFill").style.width = `${pct}%`;
    $("scanStatus").textContent = `Checked ${state.scanDone}/${state.scanSources} sources…`;
  } else if (msg.phase === "complete") {
    $("scanFill").style.width = "100%";
  }
});

// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  init();
  bindSettings();
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => switchTab(t.dataset.tab)));
  $("applyBtn").addEventListener("click", applyOnPage);
  $("scanBtn").addEventListener("click", startScan);
  $("addBtn").addEventListener("click", addCode);
  $("settingsBtn").addEventListener("click", () => ($("settingsSheet").hidden = false));
  $("closeSettings").addEventListener("click", () => ($("settingsSheet").hidden = true));
  $("scanDomain").addEventListener("keydown", (e) => { if (e.key === "Enter") startScan(); });
  $("addCode").addEventListener("keydown", (e) => { if (e.key === "Enter") addCode(); });
});
