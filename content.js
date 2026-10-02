// Meshy2GLB - isolated-world bridge: injects injected.js (MAIN world) and
// relays capture metadata + chunk requests between page and extension.
// v1.1.0: Lizenz-Gate - ohne gueltige Lizenz wird NICHT injiziert und keine
// Anfrage beantwortet. "Before anything happens" = kein Hook, kein Capture.
// NOTE v1.0.17: binary data NEVER travels as ArrayBuffer through
// chrome.* messaging (it is not JSON-serializable and arrived as {} which
// Blob() turned into the 15-byte string "[object Object]"). All chunks are
// base64 strings, which survive every hop intact.
(function () {
  let licensedCached = false;

  async function refreshLicense() {
    try {
      const st = await chrome.runtime.sendMessage({ type: 'M2G_LICENSE_STATUS' });
      licensedCached = !!(st && st.licensed);
    } catch (e) {
      licensedCached = false;
    }
    return licensedCached;
  }

  function inject() {
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('injected.js');
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {}
  }

  const pending = new Map();
  let reqSeq = 0;

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== 'm2g-injected') return;
    if (d.type === 'M2G_CAPTURE') {
      if (!licensedCached) return;
      chrome.runtime.sendMessage({ type: 'M2G_CAPTURE', capture: d.capture }).catch(() => {});
    } else if (d.type === 'M2G_LIST_RES' || d.type === 'M2G_BUFFER_RES' || d.type === 'M2G_CHUNK_RES' || d.type === 'M2G_CLEAR_RES') {
      const p = pending.get(d.reqId);
      if (p) { pending.delete(d.reqId); p.resolve(d); }
    }
  });

  function askPage(msg, timeoutMs) {
    return new Promise((resolve, reject) => {
      const reqId = 'r' + Date.now() + '-' + (++reqSeq);
      pending.set(reqId, { resolve, reject });
      window.postMessage(Object.assign({}, msg, { reqId, source: 'm2g-content' }), '*');
      setTimeout(() => {
        if (pending.has(reqId)) {
          pending.delete(reqId);
          reject(new Error('Meshy tab did not respond - refresh the meshy.ai page and try again.'));
        }
      }, timeoutMs || 20000);
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || (msg.type !== 'M2G_LIST' && msg.type !== 'M2G_GET_BUFFER' && msg.type !== 'M2G_GET_CHUNK' && msg.type !== 'M2G_CLEAR')) {
      return false;
    }
    // Live-Gate: Lizenz bei jeder Anfrage neu pruefen (kill-switch ohne Reload).
    chrome.runtime.sendMessage({ type: 'M2G_LICENSE_STATUS' }).then((st) => {
      licensedCached = !!(st && st.licensed);
      if (!licensedCached) {
        sendResponse({ ok: false, error: 'unlicensed' });
        return;
      }
      if (msg.type === 'M2G_LIST') {
        askPage({ type: 'M2G_LIST' })
          .then((d) => sendResponse({ ok: true, captures: d.captures || [] }))
          .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      } else if (msg.type === 'M2G_GET_BUFFER') {
        askPage({ type: 'M2G_GET_BUFFER', id: msg.id }, 30000)
          .then((d) => {
            if (d && d.error) {
              const em = String(d.error);
              if (em.indexOf('not-mine') !== -1) sendResponse({ ok: false, error: 'not-mine' });
              else sendResponse({ ok: false, error: d.error });
            }
            else sendResponse({ ok: true, id: d.id, filename: d.filename, size: d.size, chunks: d.chunks });
          })
          .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      } else if (msg.type === 'M2G_GET_CHUNK') {
        askPage({ type: 'M2G_GET_CHUNK', id: msg.id, index: msg.index }, 30000)
          .then((d) => {
            if (d && d.error) sendResponse({ ok: false, error: d.error });
            else sendResponse({ ok: true, id: d.id, index: d.index, data: d.data });
          })
          .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      } else if (msg.type === 'M2G_CLEAR') {
        askPage({ type: 'M2G_CLEAR' })
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
      }
    }).catch(() => {
      try { sendResponse({ ok: false, error: 'unlicensed' }); } catch (e) {}
    });
    return true;
  });

  // Boot: nur mit Lizenz injizieren. Ohne Lizenz passiert gar nichts.
  refreshLicense().then((ok) => {
    if (ok) inject();
  });
})();
