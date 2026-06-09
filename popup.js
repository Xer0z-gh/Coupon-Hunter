// Popup logic. Talks to background.js via chrome.runtime messages.

const $ = (id) => document.getElementById(id);

const state = {
  domain: null,
  tabId: null,
  codes: [],
  attempted: new Map(),
  sourcesSeen: new Set(),
};

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function rootDomain(host) {
  if (!host) return null;
  let h = host.toLowerCase().replace(/^www\./, "");
  const parts = h.split(".");
  if (parts.length < 3) return h;
  const last2 = parts.slice(-2).join(".");
  const last3 = parts.slice(-3).join(".");
  return /\.(co|com|org|gov|ac|net)\.[a-z]{2}$/.test(h) ? last3 : last2;
}

async function init() {
  const tab = await getActiveTab();
  state.tabId = tab?.id;
  let host = null;
  try {
    host = new URL(tab.url).hostname;
  } catch {}
  state.domain = rootDomain(host) || "unknown.shop";
  $("heroDomain").textContent = state.domain;

  // Load any cached codes immediately.
  chrome.runtime.sendMessage(
    { type: "get-cached", domain: state.domain },
    (res) => {
      if (res?.ok && res.codes?.length) {
        state.codes = res.codes;
        renderCodes();
        setMeta(`${res.codes.length} cached`);
      }
    }
  );

  loadSavings();
  loadSiteState();
  await loadSettings();
}

// -- Lifetime savings dashboard ---------------------------------------------
function loadSavings() {
  chrome.runtime.sendMessage({ type: "get-savings" }, (res) => {
    if (!res?.ok) return;
    $("savingsTotal").textContent = `$${(res.total || 0).toFixed(2)}`;
    $("savingsCount").textContent = res.count || 0;
    $("savingsStores").textContent = res.stores || 0;
  });
}

// -- Enabled / per-site pause -----------------------------------------------
function loadSiteState() {
  $("pauseDomain").textContent = state.domain || "this site";
  chrome.runtime.sendMessage(
    { type: "get-site-state", domain: state.domain },
    (res) => {
      if (!res?.ok) return;
      $("optEnabled").checked = res.enabled !== false;
      $("optPauseSite").checked = !!res.siteDisabled;
    }
  );
}

// -- Settings persistence ---------------------------------------------------
async function loadSettings() {
  const obj = await chrome.storage.sync.get([
    "optAutoHunt",
    "optAutoApply",
    "optFloatCard",
    "optTtl",
  ]);
  // Auto-everything is opt-out: undefined means ON.
  $("optAutoHunt").checked = obj.optAutoHunt !== false;
  $("optAutoApply").checked = obj.optAutoApply !== false;
  $("optFloatCard").checked = obj.optFloatCard !== false;
  $("optTtl").value = obj.optTtl || 6;
}

function bindSettings() {
  for (const id of ["optAutoHunt", "optAutoApply", "optFloatCard"]) {
    $(id).addEventListener("change", (e) => {
      chrome.storage.sync.set({ [id]: e.target.checked });
    });
  }
  $("optTtl").addEventListener("change", (e) => {
    const v = Math.max(1, Math.min(168, parseInt(e.target.value || "6", 10)));
    chrome.storage.sync.set({ optTtl: v });
  });
  $("clearCache").addEventListener("click", async () => {
    const all = await chrome.storage.local.get(null);
    const toClear = Object.keys(all).filter((k) =>
      k.startsWith("cohunt:cache:")
    );
    if (toClear.length) {
      await chrome.storage.local.remove(toClear);
    }
    setMeta("Cache cleared");
  });

  // Master enable / per-site pause.
  $("optEnabled").addEventListener("change", (e) => {
    chrome.runtime.sendMessage({ type: "set-enabled", enabled: e.target.checked });
  });
  $("optPauseSite").addEventListener("change", (e) => {
    chrome.runtime.sendMessage({
      type: "set-site-enabled",
      domain: state.domain,
      enabled: !e.target.checked, // checkbox = "pause", so enabled = !checked
    });
    setMeta(e.target.checked ? `Paused on ${state.domain}` : `Active on ${state.domain}`);
  });
  $("resetSavings").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "reset-savings" }, () => {
      loadSavings();
      setMeta("Savings reset");
    });
  });
}

// -- Rendering --------------------------------------------------------------
function renderCodes() {
  const wrap = $("codes");
  wrap.innerHTML = "";
  $("counter").textContent = state.codes.length;

  if (!state.codes.length) {
    $("results").hidden = true;
    return;
  }
  $("results").hidden = false;
  $("empty").hidden = true;

  for (const c of state.codes.slice(0, 50)) {
    const status = state.attempted.get(c.code) || "idle";
    const row = document.createElement("div");
    row.className = `code-row ${status}`;
    row.innerHTML = `
      <span class="code"></span>
      <span class="src"></span>
      <span class="state"></span>
    `;
    row.querySelector(".code").textContent = c.code;
    row.querySelector(".src").textContent = c.source || "";
    row.querySelector(".state").textContent =
      status === "working"
        ? c.savings
          ? `✓ –$${c.savings.toFixed(2)}`
          : "✓ saved"
        : status === "failed"
        ? "× invalid"
        : status === "trying"
        ? "trying…"
        : "—";
    row.querySelector(".code").addEventListener("click", async () => {
      await navigator.clipboard.writeText(c.code);
      setMeta(`Copied ${c.code}`);
    });
    wrap.appendChild(row);
  }

  $("autoApplyBtn").disabled = state.codes.length === 0;
}

function renderProgress() {
  const wrap = $("sourceList");
  wrap.innerHTML = "";
  for (const src of state.sourcesSeen) {
    const li = document.createElement("li");
    li.textContent = src.name;
    if (src.found > 0) li.className = "hit";
    else if (src.done) li.className = "done";
    wrap.appendChild(li);
  }
}

function setMeta(text) {
  $("footerMeta").textContent = text;
}

function setHeroPrompt(text) {
  $("heroPrompt").innerHTML = text;
}

// -- Hunt orchestration -----------------------------------------------------
function startHunt(force = false) {
  state.codes = [];
  state.attempted.clear();
  state.sourcesSeen = new Map();
  renderCodes();
  $("empty").hidden = true;
  $("progress").hidden = false;
  $("progressFill").style.width = "5%";
  $("progressLabel").textContent = `Scanning the web for ${state.domain}…`;
  setHeroPrompt(`Hunting for <b>${state.domain}</b>…`);
  setMeta("Hunting…");

  chrome.runtime.sendMessage(
    { type: "hunt", domain: state.domain, force },
    (res) => {
      $("progress").hidden = true;
      if (!res?.ok) {
        setMeta(`Error: ${res?.error || "unknown"}`);
        setHeroPrompt(`Couldn't hunt for <b>${state.domain}</b>.`);
        return;
      }
      state.codes = res.codes || [];
      renderCodes();
      if (state.codes.length) {
        setHeroPrompt(`<b>${state.codes.length} codes</b> found for ${state.domain}`);
        setMeta(`${state.codes.length} ready`);
      } else {
        setHeroPrompt(`No codes turned up for <b>${state.domain}</b>.`);
        setMeta("No matches");
        $("empty").hidden = false;
        document.querySelector(".empty-title").textContent = "Nothing yet";
        document.querySelector(".empty-sub").textContent =
          "We checked the major coupon sites and came up dry. Try ↻ to re-scan.";
      }
    }
  );
}

// Listen for streamed progress from the background.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "hunt-progress") return;
  if (msg.domain !== state.domain) return;

  if (msg.phase === "starting") {
    state.sourcesSeen = new Map(
      (msg.sources || []).map((n) => [n, { name: n, done: false, found: 0 }])
    );
    renderProgress();
    $("progressFill").style.width = "8%";
  } else if (msg.phase === "source-done") {
    const total = state.sourcesSeen.size || 1;
    const existing = state.sourcesSeen.get(msg.source) || { name: msg.source };
    existing.done = true;
    existing.found = msg.found;
    state.sourcesSeen.set(msg.source, existing);
    const done = [...state.sourcesSeen.values()].filter((s) => s.done).length;
    $("progressFill").style.width = `${Math.round((done / total) * 95) + 5}%`;
    $("progressLabel").textContent = `Checked ${done}/${total} sources — ${msg.source} (${msg.found})`;
    // Render in source-order rather than insertion-order.
    const wrap = $("sourceList");
    wrap.innerHTML = "";
    for (const src of state.sourcesSeen.values()) {
      const li = document.createElement("li");
      li.textContent = src.name;
      if (src.found > 0) li.className = "hit";
      else if (src.done) li.className = "done";
      wrap.appendChild(li);
    }
  } else if (msg.phase === "complete") {
    $("progressFill").style.width = "100%";
  }
});

// -- Auto-apply (delegates to content script via postMessage) ---------------
async function triggerAutoApply() {
  if (!state.tabId) return;
  await chrome.scripting.executeScript({
    target: { tabId: state.tabId },
    func: () => window.postMessage({ type: "cohunt:open" }, "*"),
  });
  setMeta("Auto-applying on page…");
  window.close();
}

// -- Settings sheet toggle --------------------------------------------------
function openSettings() {
  $("settingsSheet").hidden = false;
}
function closeSettings() {
  $("settingsSheet").hidden = true;
}

// -- Wire up ----------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  init();
  bindSettings();

  $("huntBtn").addEventListener("click", () => startHunt(false));
  $("refreshBtn").addEventListener("click", () => startHunt(true));
  $("settingsBtn").addEventListener("click", openSettings);
  $("closeSettings").addEventListener("click", closeSettings);
  $("autoApplyBtn").addEventListener("click", triggerAutoApply);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.altKey) {
      e.preventDefault();
      startHunt(false);
    } else if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      triggerAutoApply();
    } else if (e.key === "Escape") {
      if (!$("settingsSheet").hidden) closeSettings();
    }
  });
});
