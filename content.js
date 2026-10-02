// Meshy2GLB - isolated-world bridge: injects injected.js (MAIN world) and
// relays capture metadata + chunk requests between page and extension.
// NOTE v1.0.17: binary data NEVER travels as ArrayBuffer through
// chrome.* messaging (it is not JSON-serializable and arrived as {} which
// Blob() turned into the 15-byte string "[object Object]"). All chunks are
// base64 strings, which survive every hop intact.
(function () {
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
          } else {
            sendResponse({ ok: true, id: d.id, filename: d.filename, size: d.size, chunks: d.chunks });
          }
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
    return true;
  });

  inject();
})();
