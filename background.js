// Meshy2GLB - service worker: Capture-Metadaten pro Tab (aus allen
// Frames gemergt) + Badge. Die Binaerdaten bleiben in der Seite;
// das Popup holt sie gezielt per frameId ab.
const keyFor = (tabId) => 'm2g_tab_' + tabId;

// Meshys eigener Download (UUID-Muell mit/ohne Endung, Alle-Dateien-Filter)
// bekommt einen sinnvollen .glb-Namen: bevorzugt den zuletzt erfassten
// Capture-Namen des Meshy-Tabs, fallback wenigstens .glb-Endung.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuidLikeBg(base) {
  const s = String(base || '');
  if (UUID_RE.test(s)) return true;
  if (s.length >= 20 && /^[0-9a-f\-_]+$/i.test(s) && /[0-9a-f]{8}/i.test(s) && s.indexOf(' ') === -1) return true;
  return false;
}

try {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    try {
      var url = String((item && item.url) || "");
      var ref = String((item && item.referrer) || "");
      var finalUrl = String((item && item.finalUrl) || "");
      var meshyCtx = url.indexOf("meshy.ai") !== -1 || ref.indexOf("meshy.ai") !== -1 || finalUrl.indexOf("meshy.ai") !== -1 || url.indexOf("blob:") === 0;
      var full = String((item && item.filename) || "");
      if (!full) return;
      var dir = full.replace(/[^\/\\]*$/, "");
      var name = full.split("/").pop().split("\\").pop();
      var m = name.match(/^(.*)\.([a-z0-9]{2,5})$/i);
      var base = m ? m[1] : name;
      var ext = m ? m[2].toLowerCase() : "";
      var uuid = isUuidLikeBg(base);
      if (ext && ext !== "glb") return;
      if (ext === "glb" && !uuid) return;
      if (!ext && !uuid && !meshyCtx) return;
      (async () => {
        var best = null;
        try {
          var tabs = await chrome.tabs.query({ url: ["https://meshy.ai/*", "https://*.meshy.ai/*"] });
          for (var ti = 0; ti < (tabs || []).length; ti++) {
            var t = tabs[ti];
            if (t == null || t.id == null) continue;
            try {
              var got = await chrome.storage.session.get(keyFor(t.id));
              var list = got[keyFor(t.id)] || [];
              for (var ci = 0; ci < list.length; ci++) {
                var c = list[ci];
                if (!c || !c.filename) continue;
                if (!best || (c.time || 0) > (best.time || 0)) best = c;
              }
            } catch (e) {}
          }
        } catch (e) {}
        if (best && best.filename && /\.glb$/i.test(String(best.filename))) {
          try {
            var clean = String(best.filename).split("/").pop().split("\\").pop();
            suggest({ filename: dir + clean, conflictAction: "uniquify" });
            return;
          } catch (e) {}
        }
        if (!meshyCtx) return;
        try {
          if (uuid) suggest({ filename: dir + "model.glb", conflictAction: "uniquify" });
          else if (/\.glb$/i.test(name)) suggest({ filename: full, conflictAction: "uniquify" });
          else if (!ext) suggest({ filename: dir + base + ".glb", conflictAction: "uniquify" });
          else suggest({ filename: full + ".glb", conflictAction: "uniquify" });
        } catch (e) {}
      })();
      return true;
    } catch (e) {}
  });
} catch (e) {}

async function loadCaptures(tabId) {
  try {
    const got = await chrome.storage.session.get(keyFor(tabId));
    return got[keyFor(tabId)] || [];
  } catch (e) { return []; }
}

async function saveCaptures(tabId, list) {
  try { await chrome.storage.session.set({ [keyFor(tabId)]: list }); } catch (e) {}
}

async function updateBadge(tabId) {
  try {
    const list = await loadCaptures(tabId);
    await chrome.action.setBadgeText({ tabId, text: list.length ? String(list.length) : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#00e676' });
  } catch (e) {}
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg && msg.type === 'M2G_CAPTURE') {
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) { sendResponse({ ok: true }); return; }
      const frameId = (sender && typeof sender.frameId === 'number') ? sender.frameId : 0;
      const cap = Object.assign({}, msg.capture, { frameId });
      const list = await loadCaptures(tabId);
      if (!list.some((c) => c.id === cap.id)) {
        list.push(cap);
        await saveCaptures(tabId, list);
      }
      await updateBadge(tabId);
      sendResponse({ ok: true });
    } else if (msg && msg.type === 'M2G_GET_TAB_CAPTURES') {
      sendResponse({ ok: true, captures: await loadCaptures(msg.tabId) });
    } else if (msg && msg.type === 'M2G_TAB_CLEARED') {
      await saveCaptures(msg.tabId, []);
      await updateBadge(msg.tabId);
      sendResponse({ ok: true });
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  try { chrome.storage.session.remove(keyFor(tabId)).catch(() => {}); } catch (e) {}
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    saveCaptures(tabId, []).then(() => updateBadge(tabId));
  }
});
