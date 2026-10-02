// Meshy2GLB v1.0.3 - MAIN-world capture engine (alle Frames).
// Fängt GLBs auf mehreren Wegen: Worker-Decrypt, fetch, XHR,
// Response.arrayBuffer/blob, Viewer-Blobs. Erkennung per glTF-Magie,
// nicht nur per URL - funktioniert auch bei signierten CDN-URLs und
// octet-stream-Downloads.
(function () {
  if (window.__m2gInjected) return;
  window.__m2gInjected = true;

  var TAG = '[Meshy2GLB]';
  function log() {
    try { console.log.apply(console, ['%c' + TAG, 'color:#00e676;font-weight:bold'].concat([].slice.call(arguments))); }
    catch (e) {}
  }
  log('bereit - Modell auf meshy.ai oeffnen/exportieren, dann im Popup speichern.');

  // Meshy-Downloads geradeziehen: UUID-Muell (mit/ohne Endung) und
  // Alle-Dateien-Filter -> sinnvoller Dateiname mit .glb + GLB-Dateityp.
  // Echte Endungen (.png/.jpg/.mp4/...) bleiben unberuehrt.
  function m2gIsUuidLike(base) {
    var s = String(base || '');
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
    if (s.length >= 20 && /^[0-9a-f\-_]+$/i.test(s) && /[0-9a-f]{8}/i.test(s) && s.indexOf(' ') === -1) return true;
    return false;
  }
  function m2gNeedsFix(nm) {
    var s = String(nm || '');
    if (!s) return true;
    var m = s.match(/\.([a-z0-9]{2,5})$/i);
    if (!m) return true;
    if (m[1].toLowerCase() === 'glb' && m2gIsUuidLike(s.slice(0, s.length - m[0].length))) return true;
    return false;
  }
  function m2gFixName(nm) {
    if (!m2gNeedsFix(nm)) return null;
    var fixed = null;
    try { fixed = pageBase() + '.glb'; } catch (e) { fixed = 'model.glb'; }
    try { log('Dateiname gefixt:', nm, '->', fixed); } catch (e) {}
    return fixed;
  }
  function m2gGlbTypes() {
    return [{ description: 'GLB 3D model (*.glb)', accept: { 'model/gltf-binary': ['.glb'] } }];
  }
  try {
    if (window.showSaveFilePicker) {
      var origPicker = window.showSaveFilePicker.bind(window);
      window.showSaveFilePicker = function (opts) {
        try {
          opts = Object.assign({}, opts || {});
          var fixed = m2gFixName(opts.suggestedName);
          if (fixed) {
            opts.suggestedName = fixed;
            opts.types = m2gGlbTypes();
            opts.excludeAcceptAllOption = true;
          } else if (/\.glb$/i.test(String(opts.suggestedName || ''))) {
            opts.types = m2gGlbTypes();
            opts.excludeAcceptAllOption = true;
          }
        } catch (e) {}
        return origPicker(opts);
      };
    }
  } catch (e) {}
  function m2gFixAnchor(a) {
    try {
      if (!a || !a.hasAttribute || !a.hasAttribute('download')) return;
      var cur = a.getAttribute('download') || a.download || '';
      var fixed = m2gFixName(cur);
      if (fixed) {
        a.setAttribute('download', fixed);
        try { a.download = fixed; } catch (e) {}
      }
    } catch (e) {}
  }
  try {
    var origAClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      try { m2gFixAnchor(this); } catch (e) {}
      return origAClick.apply(this, arguments);
    };
  } catch (e) {}
  try {
    var dlDesc = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'download');
    if (dlDesc && dlDesc.set && !HTMLAnchorElement.prototype.__m2gDlPatched) {
      var origDlSet = dlDesc.set;
      Object.defineProperty(HTMLAnchorElement.prototype, 'download', {
        configurable: true,
        enumerable: dlDesc.enumerable,
        get: dlDesc.get,
        set: function (v) {
          try {
            var fixed = m2gFixName(v);
            if (fixed) v = fixed;
          } catch (e) {}
          return origDlSet.call(this, v);
        }
      });
      HTMLAnchorElement.prototype.__m2gDlPatched = true;
    }
  } catch (e) {}

  // Klicks abfangen (auch synthetische dispatchEvent-Klicks, die an
  // HTMLAnchorElement.prototype.click vorbeigehen).
  try {
    window.addEventListener('click', function (ev) {
      try {
        var t = ev && ev.target;
        var a = null;
        if (t && t.closest) a = t.closest('a[download]');
        if (!a) {
          try {
            if (t && t.nodeType === 1 && t.hasAttribute && t.hasAttribute('download')) a = t;
          } catch (e) {}
        }
        if (a) m2gFixAnchor(a);
      } catch (e) {}
    }, true);
  } catch (e) {}
  // download-Attribute per MutationObserver sofort geradeziehen.
  try {
    var m2gObs = new MutationObserver(function (muts) {
      try {
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === 'attributes' && m.attributeName === 'download' && m.target) {
            m2gFixAnchor(m.target);
          } else if (m.type === 'childList') {
            var nodes = m.addedNodes || [];
            for (var j = 0; j < nodes.length; j++) {
              var n = nodes[j];
              if (!n || n.nodeType !== 1) continue;
              if (n.hasAttribute && n.hasAttribute('download')) m2gFixAnchor(n);
              try {
                var links = n.querySelectorAll ? n.querySelectorAll('a[download]') : [];
                for (var k = 0; k < links.length; k++) m2gFixAnchor(links[k]);
              } catch (e) {}
            }
          }
        }
      } catch (e) {}
    });
    var m2gObsTarget = null;
    try { m2gObsTarget = document.documentElement || document; } catch (e) {}
    if (m2gObsTarget) {
      try {
        m2gObs.observe(m2gObsTarget, { subtree: true, childList: true, attributes: true, attributeFilter: ['download'] });
      } catch (e) {
        try { m2gObs.observe(m2gObsTarget, { subtree: true, childList: true, attributes: true }); } catch (e2) {}
      }
    }
  } catch (e) {}

  var captures = new Map();
  var seq = 0;
  var MAX_KEEP = 10;
  var MAX_SIZE = 262144000; // 250 MB Schutz vor OOM

  function metas() {
    return Array.from(captures.values()).map(function (c) {
      return { id: c.id, size: c.size, src: c.src, time: c.time, filename: c.filename };
    });
  }

  function magicIsGLB(buf, off) {
    try {
      if (!buf || buf.byteLength < (off || 0) + 4) return false;
      return new DataView(buf, off || 0, 4).getUint32(0, true) === 0x46546C67;
    } catch (e) { return false; }
  }

  function isGLBBuffer(buf) {
    return !!buf && buf.byteLength >= 12 && magicIsGLB(buf, 0);
  }

  function looksLikeGLBUrl(url) {
    if (!url || typeof url !== 'string') return false;
    var u = url.toLowerCase();
    return u.indexOf('.glb') !== -1 || u.indexOf('misc/cdn-models') !== -1;
  }

  function looksLikeGLBType(ct) {
    if (!ct) return false;
    var t = String(ct).toLowerCase();
    return t.indexOf('gltf') !== -1 || t.indexOf('model/glb') !== -1;
  }

  // Statische Assets (JS/CSS/WASM/Bilder/...): nie den Body lesen, spart RAM.
  var STATIC_RE = /\.(js|mjs|css|map|json|wasm|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|webm|mp3|wav|ogg)(\?|#|$)/i;

  function shouldSniffBody(url, ct, len) {
    if (looksLikeGLBUrl(url) || looksLikeGLBType(ct)) return true;
    if (STATIC_RE.test(url || '')) return false;
    if (!ct) return (len || 0) >= 500000;
    var t = String(ct).toLowerCase();
    if (t.indexOf('video') !== -1 || t.indexOf('audio') !== -1 || t.indexOf('image') !== -1) return false;
    if (t.indexOf('text') !== -1 || t.indexOf('json') !== -1 || t.indexOf('javascript') !== -1 || t.indexOf('wasm') !== -1) return false;
    if (t.indexOf('octet-stream') !== -1) return (len || 1000000) >= 100000;
    return false;
  }

  function pageBase() {
    return "model";
  }

  function store(buffer, src) {
    if (!(buffer instanceof ArrayBuffer)) return;
    if (!buffer || buffer.byteLength < 1000) return;
    if (buffer.byteLength > MAX_SIZE) { log('Fund zu gross, uebersprungen (' + src + ').'); return; }
    var now = Date.now();
    var dup = false;
    captures.forEach(function (c) {
      if (c.size === buffer.byteLength && now - c.time < 10000) dup = true;
    });
    if (dup) return;
    seq++;
    var id = 'glb-' + now + '-' + seq;
    var filename = pageBase() + '_' + seq + '.glb';
    var copy = null;
    try { copy = buffer.slice(0); } catch (e) { return; }
    captures.set(id, { id: id, buffer: copy, size: copy.byteLength, src: src, time: now, filename: filename });
    while (captures.size > MAX_KEEP) {
      captures.delete(captures.keys().next().value);
    }
    log('erfasst (' + src + ') ' + (copy.byteLength / 1048576).toFixed(2) + ' MB -> im Popup speichern.');
    try {
      window.postMessage({ source: 'm2g-injected', type: 'M2G_CAPTURE', capture: { id: id, size: copy.byteLength, src: src, time: now, filename: filename } }, '*');
    } catch (e) {}
  }

  function checkBuf(buf, src) {
    if (isGLBBuffer(buf)) { log(src + ': GLB erkannt.'); try { store(buf, src.toLowerCase().split(':')[0]); } catch (e) {} }
  }

  // Generischer Scan: findet GLB-ArrayBuffers auch bei geaendertem
  // Worker-Protokoll (sucht 3 Ebenen tief, erkennt Zyklen).
  var MAX_KEYS = 100;
  function scanValue(v, depth, seen) {
    if (v == null || depth > 3) return null;
    try {
      if (v instanceof ArrayBuffer) return isGLBBuffer(v) ? v : null;
      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(v)) {
        var off = v.byteOffset || 0;
        if (v.byteLength >= 12 && magicIsGLB(v.buffer, off)) {
          try { return v.buffer.slice(off, off + v.byteLength); } catch (e) { return null; }
        }
        return null;
      }
      if (v instanceof Blob) {
        if (v.size > 100000 || v.type === 'model/gltf-binary') {
          v.arrayBuffer().then(function (buf) {
            if (isGLBBuffer(buf)) store(buf, 'worker-blob');
          }).catch(function () {});
        }
        return null;
      }
      if (Array.isArray(v)) {
        for (var i = 0; i < v.length; i++) {
          var r = scanValue(v[i], depth + 1, seen);
          if (r) return r;
        }
        return null;
      }
      if (typeof v === 'object') {
        if (seen.has(v)) return null;
        seen.add(v);
        var keys = Object.keys(v);
        for (var k = 0; k < keys.length && k < MAX_KEYS; k++) {
          var rv = scanValue(v[keys[k]], depth + 1, seen);
          if (rv) return rv;
        }
      }
    } catch (e) {}
    return null;
  }

  function onWorkerMessage(e) {
    var d = e && e.data;
    if (!d) return;
    if (typeof d === 'object' && d.type === 'process' && d.success && d.data) {
      try {
        if (d.data instanceof ArrayBuffer && isGLBBuffer(d.data)) {
          log('Worker: entschluesseltes GLB erkannt.');
          try { store(d.data.slice(0), 'worker'); } catch (ex) {}
          return;
        }
      } catch (e2) {}
    }
    var found = null;
    try { found = scanValue(d, 0, new Set()); } catch (e3) {}
    if (found) {
      log('Worker: GLB in Nachricht gefunden.');
      try { store(found, 'worker'); } catch (e4) {}
    }
  }

  // HOOK: Worker (Meshy entschluesselt MESHY.AI-Payloads im WASM-Worker).
  try {
    var OrigWorker = window.Worker;
    if (OrigWorker) {
      window.Worker = function MeshyWorkerProxy(scriptURL, options) {
        var w = new OrigWorker(scriptURL, options);
        try {
          var proto = Object.getPrototypeOf(w);
          var desc = Object.getOwnPropertyDescriptor(proto, 'onmessage');
          if (desc && desc.set) {
            Object.defineProperty(w, 'onmessage', {
              configurable: true,
              get: function () { return desc.get ? desc.get.call(w) : undefined; },
              set: function (fn) {
                if (typeof fn !== 'function') { desc.set.call(w, fn); return; }
                desc.set.call(w, function (e) { onWorkerMessage(e); return fn.call(this, e); });
              }
            });
          }
          var origAEL = w.addEventListener.bind(w);
          w.addEventListener = function (type, listener, opts) {
            if (type === 'message' && typeof listener === 'function') {
              return origAEL(type, function (e) { onWorkerMessage(e); return listener.call(this, e); }, opts);
            }
            return origAEL(type, listener, opts);
          };
        } catch (e) {}
        return w;
      };
      window.Worker.prototype = OrigWorker.prototype;
      try {
        Object.defineProperty(window.Worker, Symbol.hasInstance, {
          value: function (instance) { return instance instanceof OrigWorker; }
        });
      } catch (e) {}
    }
  } catch (e) {}

  // HOOK: fetch - mit Sniffing auch fuer octet-stream / grosse Binaer-Bodies.
  try {
    var origFetch = window.fetch;
    window.fetch = function (input) {
      var url = '';
      try { url = typeof input === 'string' ? input : (input && input.url) || String(input); } catch (e) {}
      var p = origFetch.apply(this, arguments);
      return p.then(function (resp) {
        try {
          var ct = '', len = 0;
          try {
            if (resp.headers) {
              ct = resp.headers.get('content-type') || '';
              len = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
            }
          } catch (e) {}
          if (shouldSniffBody(url, ct, len)) {
            resp.clone().arrayBuffer().then(function (buf) {
              checkBuf(buf, 'Fetch');
            }).catch(function () {});
          }
        } catch (e) {}
        return resp;
      });
    };
  } catch (e) {}

  // HOOK: Response.arrayBuffer/blob - faengt jeden Binaer-Pfad ab, egal
  // ueber welche URL er kam (Magie-Check kostet nur 4 Byte).
  try {
    var RProto = window.Response && window.Response.prototype;
    if (RProto && RProto.arrayBuffer) {
      var origRespAB = RProto.arrayBuffer;
      RProto.arrayBuffer = function () {
        return origRespAB.call(this).then(function (buf) {
          try { checkBuf(buf, 'Response'); } catch (e) {}
          return buf;
        });
      };
    }
    if (RProto && RProto.blob) {
      var origRespBlob = RProto.blob;
      RProto.blob = function () {
        return origRespBlob.call(this).then(function (b) {
          try {
            if (b && (b.type === 'model/gltf-binary' || b.size > 100000)) {
              b.arrayBuffer().then(function (buf) { checkBuf(buf, 'Response'); }).catch(function () {});
            }
          } catch (e) {}
          return b;
        });
      };
    }
  } catch (e) {}

  // HOOK: XMLHttpRequest (arraybuffer/blob-Antworten mit Groessen-Gate).
  try {
    var OrigXHR = window.XMLHttpRequest;
    if (OrigXHR) {
      var origOpen = OrigXHR.prototype.open;
      var origSend = OrigXHR.prototype.send;
      OrigXHR.prototype.open = function (method, url) {
        try { this.__m2gUrl = String(url || ''); } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      OrigXHR.prototype.send = function () {
        try {
          this.addEventListener('load', function () {
            try {
              if (this.responseType !== 'arraybuffer' && this.responseType !== 'blob') return;
              if (STATIC_RE.test(this.__m2gUrl || '')) return;
              var r = this.response;
              if (r instanceof ArrayBuffer) {
                if (r.byteLength > 100000) checkBuf(r, 'XHR');
              } else if (r instanceof Blob) {
                if (r.size > 100000 || r.type === 'model/gltf-binary') {
                  r.arrayBuffer().then(function (buf) { checkBuf(buf, 'XHR'); }).catch(function () {});
                }
              }
            } catch (e) {}
          });
        } catch (e) {}
        return origSend.apply(this, arguments);
      };
    }
  } catch (e) {}

  // HOOK: createObjectURL (Viewer uebergibt GLB-Blob an Renderer).
  try {
    var origCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (blob) {
      var url = origCreateObjectURL(blob);
      try {
        if (blob instanceof Blob) {
          var nm = (blob instanceof File && blob.name) ? blob.name : '';
          if (blob.type === 'model/gltf-binary' || /\.glb$/i.test(nm)) {
            blob.arrayBuffer().then(function (buf) {
              if (isGLBBuffer(buf)) { log('Viewer: GLB-Blob erkannt.'); store(buf, 'viewer'); }
            }).catch(function () {});
          } else if (blob.size > 100000) {
            blob.arrayBuffer().then(function (buf) {
              if (isGLBBuffer(buf)) store(buf, 'viewer');
            }).catch(function () {});
          }
        }
      } catch (e) {}
      return url;
    };
  } catch (e) {}

    // TAKEOVER: Meshy blob downloads direkt mit richtigem Namen speichern, ohne Dialog.
  function m2gTakeoverName() {
    try {
      var best = null;
      captures.forEach(function (c) { if (!best || c.time > best.time) best = c; });
      if (best && best.filename && /\.glb$/i.test(best.filename)) return best.filename;
    } catch (e) {}
    try { return pageBase() + ".glb"; } catch (e) {}
    return "meshy-model.glb";
  }
  function m2gBlobHref(a) {
    try {
      var h = a.href || "";
      if (h && h.indexOf("blob:") === 0) return h;
      try { h = a.getAttribute("href") || ""; } catch (e) {}
      if (h && h.indexOf("blob:") === 0) return h;
    } catch (e) {}
    return null;
  }
  function m2gNativeFallback(a) {
    try {
      var fixed = null;
      try { fixed = m2gFixName(a.getAttribute("download") || a.download || ""); } catch (e) {}
      if (fixed) {
        try { a.setAttribute("download", fixed); } catch (e) {}
        try { a.download = fixed; } catch (e2) {}
      }
    } catch (e) {}
    try {
      a.setAttribute("data-m2g-native", "1");
      var oc = window.__m2gOrigClick || null;
      setTimeout(function () { try { a.removeAttribute("data-m2g-native"); } catch (e) {} }, 1500);
      if (oc) { try { oc.call(a); } catch (e) {} }
    } catch (e) {}
  }
  function m2gTakeover(a, href) {
    try { log("Meshy download stays native, filename fixed to .glb."); } catch (e) {}
    function done() { try { m2gNativeFallback(a); } catch (e) {} }
    try {
      fetch(href).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
        try {
          if (buf && (buf instanceof ArrayBuffer) && isGLBBuffer(buf)) { try { store(buf, "takeover"); } catch (e) {} }
        } catch (e) {}
        done();
      }).catch(function () { done(); });
    } catch (e) { done(); }
  }
  function m2gMaybeTakeover(a) {
    try {
      if (!a || !a.hasAttribute) return false;
      try { if (a.hasAttribute("data-m2g-native")) return false; } catch (e) {}
      try { if (a.getAttribute("data-m2g-native") === "1") return false; } catch (e) {}
      var href = m2gBlobHref(a);
      if (!href) return false;
      return href;
    } catch (e) { return false; }
  }
  try {
    window.addEventListener("click", function (ev) {
      try {
        var t = ev && ev.target;
        var a = null;
        if (t && t.closest) a = t.closest("a[download]");
        if (!a && t && t.nodeType === 1 && t.hasAttribute && t.hasAttribute("download")) a = t;
        if (!a) return;
        var href = m2gMaybeTakeover(a);
        if (!href) return;
        if (ev.preventDefault) ev.preventDefault();
        if (ev.stopPropagation) ev.stopPropagation();
        if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        m2gTakeover(a, href);
      } catch (e) {}
    }, true);
  } catch (e) {}
  try {
    window.__m2gOrigClick = window.__m2gOrigClick || HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      try {
        var href = m2gMaybeTakeover(this);
        if (href) { m2gTakeover(this, href); return; }
        try { m2gFixAnchor(this); } catch (e) {}
      } catch (e) {}
      return window.__m2gOrigClick.apply(this, arguments);
    };
  } catch (e) {}

  var M2G_CHUNK = 192 * 1024;
  function m2gB64encode(buf) {
    try {
      var bytes = new Uint8Array(buf);
      var s = "";
      var C = 32768;
      for (var i = 0; i < bytes.length; i += C) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + C));
      }
      return btoa(s);
    } catch (e) { return ""; }
  }

// Bruecke zum Content-Skript.
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.source !== 'm2g-content') return;
    if (d.type === 'M2G_LIST') {
      window.postMessage({ source: 'm2g-injected', type: 'M2G_LIST_RES', reqId: d.reqId, captures: metas() }, '*');
    } else if (d.type === 'M2G_GET_BUFFER') {
      var c = captures.get(d.id);
      if (!c) {
        window.postMessage({ source: 'm2g-injected', type: 'M2G_BUFFER_RES', reqId: d.reqId, error: 'not-mine' }, '*');
        return;
      }
      try {
        var total = Math.max(1, Math.ceil(c.buffer.byteLength / M2G_CHUNK));
        window.postMessage({ source: 'm2g-injected', type: 'M2G_BUFFER_RES', reqId: d.reqId, ok: true, id: c.id, filename: c.filename, size: c.size, chunks: total }, '*');
      } catch (err) {
        window.postMessage({ source: 'm2g-injected', type: 'M2G_BUFFER_RES', reqId: d.reqId, error: String(err) }, '*');
      }
    } else if (d.type === 'M2G_GET_CHUNK') {
      var c2 = captures.get(d.id);
      if (!c2) {
        window.postMessage({ source: 'm2g-injected', type: 'M2G_CHUNK_RES', reqId: d.reqId, error: 'not-mine' }, '*');
        return;
      }
      try {
        var idx = d.index | 0;
        var start = idx * M2G_CHUNK;
        if (start >= c2.buffer.byteLength) {
          window.postMessage({ source: 'm2g-injected', type: 'M2G_CHUNK_RES', reqId: d.reqId, error: 'bad-index' }, '*');
          return;
        }
        var end = Math.min(start + M2G_CHUNK, c2.buffer.byteLength);
        var part = c2.buffer.slice(start, end);
        var b64 = m2gB64encode(part);
        window.postMessage({ source: 'm2g-injected', type: 'M2G_CHUNK_RES', reqId: d.reqId, ok: true, id: c2.id, index: idx, data: b64 }, '*');
      } catch (err2) {
        window.postMessage({ source: 'm2g-injected', type: 'M2G_CHUNK_RES', reqId: d.reqId, error: String(err2) }, '*');
      }
    } else if (d.type === 'M2G_CLEAR') {
      captures.clear();
      window.postMessage({ source: 'm2g-injected', type: 'M2G_CLEAR_RES', reqId: d.reqId, ok: true }, '*');
    }
  });

  try {
    window.__m2gStatus = function () {
      return { injected: true, captures: metas().length, href: location.href };
    };
  } catch (e) {}
})();
