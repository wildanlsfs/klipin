// Klik ikon extension → buka side panel (berdampingan dengan tab Google Flow).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('[Tuyul] setPanelBehavior', e));
