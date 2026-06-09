// Welcome page — closes itself when the user clicks "Start saving".
document.getElementById("done")?.addEventListener("click", async () => {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) chrome.tabs.remove(tab.id);
    else window.close();
  } catch {
    window.close();
  }
});
