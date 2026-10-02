// Meshy2GLB popup: Liste (Top-Frame live + alle Frames via
// Background gemergt), Auto-Refresh bei neuen Funden, Speichern-unter
// (Picker) + Schnell-Download.
(function () {
  'use strict';

  function $(s) {
    try { return document.querySelector(s); } catch (e) { return null; }
  }

  function on(id, evt, fn) {
    var el = null;
    try { el = document.getElementById(id); } catch (e) { el = null; }
    if (el) { el.addEventListener(evt, fn); return true; }
    try { console.warn('[Meshy2GLB] Popup-Element fehlt: #' + id); } catch (e) {}
    return false;
  }

  const listEl = $('#list');
  const emptyEl = $('#empty');
  const noticeEl = $('#notice');
  const pillEl = $('#statusPill');
  const diagEl = $('#diag');
  const DBG = { bg: '-', live: '-', bcast: '-', tab: '-' };
  let TAB = null;
  let ITEMS = [];
  let POLL = null;
  let softRunning = false;

  function notice(msg, ok) {
    if (!noticeEl) return;
    if (!msg) { noticeEl.classList.add('hidden'); noticeEl.textContent = ''; return; }
    noticeEl.textContent = msg;
    noticeEl.classList.toggle('ok', !!ok);
    noticeEl.classList.remove('hidden');
  }

  function updateDiag() {
    if (!diagEl) return;
    try { diagEl.textContent = 'Tab ' + DBG.tab + ' | BG: ' + DBG.bg + ' | Top-Frame: ' + DBG.live + ' | Broadcast: ' + DBG.bcast; } catch (e) {}
  }

  function setPill(text, cls) {
    if (!pillEl) return;
    pillEl.textContent = text;
    pillEl.className = 'pill' + (cls ? ' ' + cls : '');
  }

  function fmtBytes(n) {
    if (n == null) return '?';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function fmtTime(t) {
    try { return new Date(t).toLocaleTimeString(); } catch (e) { return ''; }
  }

  function isUuidLike(base) {
    var s = String(base || '');
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
    if (s.length >= 20 && /^[0-9a-f\-_]+$/i.test(s) && /[0-9a-f]{8}/i.test(s) && s.indexOf(' ') === -1) return true;
    return false;
  }

  function tabTitleBase() {
    var t = '';
    try { t = String((TAB && TAB.title) || ''); } catch (e) { t = ''; }
    t = t.replace(/\s*[-|_]\s*meshy.*$/i, '').replace(/^\s*meshy\s*[-|_]\s*/i, '').trim();
    t = t.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    if (t.length > 60) t = t.slice(0, 60).replace(/_+$/g, '');
    return t;
  }

  function fixName(n) {
    var s = String(n || 'model.glb').trim() || 'model.glb';
    s = s.replace(/[\\/:*?"<>|]+/g, '_');
    var m = s.match(/^(.*)\.([a-z0-9]{2,5})$/i);
    var base = m ? m[1] : s;
    if (base && isUuidLike(base)) {
      var tb = tabTitleBase();
      s = 'model' + '.glb';
    }
    if (!/\.glb$/i.test(s)) s += '.glb';
    return s;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Lucide icons (inline SVG, no remote/CDN payload – MV3 CSP verbietet Remote-Skripte)
  function lucide(paths) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide" aria-hidden="true">' + paths + '</svg>';
  }
  const IC_SAVE = lucide('<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" /><path d="M7 3v4a1 1 0 0 0 1 1h7" />');
  const IC_DOWNLOAD = lucide('<path d="M12 15V3" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" />');
  const IC_FILE_DOWN = lucide('<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M12 18v-6" /><path d="m9 15 3 3 3-3" />');
  const IC_ZIP = lucide('<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M9 13h6" /><path d="M9 17h6" />');

  async function openMeshy() {
    const url = 'https://www.meshy.ai/workspace';
    try {
      await chrome.tabs.create({ url });
      window.close();
    } catch (e1) {
      try {
        const t = await chrome.tabs.query({ active: true, currentWindow: true });
        if (t && t[0] && t[0].id != null) {
          await chrome.tabs.update(t[0].id, { url });
          window.close();
          return;
        }
        throw e1;
      } catch (e2) {
        window.open(url, '_blank');
      }
    }
  }

  async function reloadTab() {
    if (!TAB || TAB.id == null) { notice('No tab to reload found.'); return; }
    try {
      await chrome.tabs.reload(TAB.id);
      notice('Reloading tab - then open/export the model on meshy.ai, the list fills automatically.', true);
    } catch (e) {
      notice('Reload failed: ' + e.message);
    }
  }

  function isMeshyUrl(u) {
    return !!u && (u.indexOf('meshy.ai') !== -1);
  }

  function isConnErr(e) {
    const m = String((e && e.message) || e);
    return m.indexOf('Receiving end does not exist') !== -1 || m.indexOf('Could not establish connection') !== -1;
  }

  function sendMsg(payload, opts, ms) {
    ms = ms || 8000;
    return Promise.race([
      chrome.tabs.sendMessage(TAB.id, payload, opts || {}),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout (' + ms + 'ms)')), ms))
    ]);
  }

  // Live-Liste aus dem Haupt-Frame (frameId 0).
  async function liveTopList() {
    const res = await sendMsg({ type: 'M2G_LIST' }, { frameId: 0 });
    if (!res || !res.ok) throw new Error((res && res.error) || 'no response from page');
    return (res.captures || []).map((c) => Object.assign({ frameId: 0 }, c));
  }

  // Broadcast an ALLE Frames (ohne frameId): fängt Fälle ab, in denen das
  // Modell in einem iframe-Viewer entschlüsselt wurde.
  async function liveBroadcastList() {
    const res = await sendMsg({ type: 'M2G_LIST' }, {});
    if (!res || !res.ok) throw new Error((res && res.error) || 'no response (broadcast)');
    return (res.captures || []).map((c) => Object.assign({ frameId: (c.frameId != null ? c.frameId : 0) }, c));
  }

  // Gemergte Liste aus dem Background (alle Frames).
  async function bgList() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'M2G_GET_TAB_CAPTURES', tabId: TAB.id });
      if (res && res.ok && res.captures) return res.captures;
    } catch (e) {}
    return [];
  }

  async function mergedList() {
    let live = [], bcast = [];
    try { live = await liveTopList(); DBG.live = String(live.length); }
    catch (e) { live = []; DBG.live = 'ERR: ' + String((e && e.message) || e).slice(0, 60); }
    try { bcast = await liveBroadcastList(); DBG.bcast = String(bcast.length); }
    catch (e) { bcast = []; DBG.bcast = 'ERR: ' + String((e && e.message) || e).slice(0, 60); }
    let bg = [];
    try { bg = await bgList(); DBG.bg = String(bg.length); }
    catch (e) { bg = []; DBG.bg = 'ERR'; }
    try { DBG.tab = String(TAB && TAB.id); } catch (e) {}
    updateDiag();
    const map = new Map();
    bg.forEach((c) => map.set(c.id, c));
    live.forEach((c) => { if (!map.has(c.id)) map.set(c.id, c); });
    bcast.forEach((c) => { if (!map.has(c.id)) map.set(c.id, c); });
    return Array.from(map.values()).sort((a, b) => (b.time || 0) - (a.time || 0));
  }

  async function load() {
    notice(null);
    if (!TAB || !isMeshyUrl(TAB.url || '')) {
      setPill('not on Meshy', 'warn');
      ITEMS = [];
      render();
      notice('Pin the extension, then open a meshy.ai tab and export a model there.');
      return;
    }
    setPill('Meshy tab', 'ok');
    ITEMS = await mergedList();
    if (!ITEMS.length) {
      // Prüfen, ob das Content-Skript überhaupt erreichbar ist.
      try {
        const res = await chrome.tabs.sendMessage(TAB.id, { type: 'M2G_LIST' }, { frameId: 0 });
        if (!res || !res.ok) throw new Error('no-contact');
      } catch (e) {
        if (isConnErr(e)) {
          render();
          notice('No contact to the Meshy tab: Script missing (tab was open before installation). Click "Reload tab" below, then open/export a model.');
          return;
        }
      }
    }
    render();
    if (ITEMS.length) {
      setPill(ITEMS.length + ' ready', 'ok');
      notice(ITEMS.length + ' model(s) ready – use Save as to pick a folder.', true);
    }
  }

  // Leiser Refresh für Polling + Storage-Events: rendert nur neu, wenn
  // sich die Fund-Liste geändert hat.
  async function softRefresh() {
    if (softRunning || !TAB || TAB.id == null) return;
    try {
      if (document.querySelector('.btn:disabled')) return;
    } catch (e) {}
    softRunning = true;
    try {
      const bg = await bgList();
      const ids = bg.map((c) => c.id).join(',');
      const cur = ITEMS.map((c) => c.id).join(',');
      if (ids !== cur) {
        ITEMS = await mergedList();
        render();
        if (ITEMS.length) {
          setPill(ITEMS.length + ' ready', 'ok');
          notice(ITEMS.length + ' model(s) ready – use Save as to pick a folder.', true);
        }
      }
    } catch (e) {} finally { softRunning = false; }
  }

  function render() {
    try { updateDiag(); } catch (e) {}
    if (emptyEl) emptyEl.style.display = ITEMS.length ? 'none' : '';
    if (!listEl) return;
    listEl.innerHTML = '';
    ITEMS.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<div class="row1"><div class="file-ico">G</div>' +
        '<div><div class="name">' + esc(fixName(item.filename || 'model.glb')) + '</div>' +
        '<div class="meta">' + esc(fmtBytes(item.size)) + ' &middot; ' + esc(fmtTime(item.time)) + '</div></div>' +
        '<span class="src">' + esc(item.src || 'glb') + '</span></div>' +
        '<div class="actions"><button class="btn primary" data-act="save">' + IC_SAVE + '<span>Save as…</span></button>' +
        '<button class="btn secondary" data-act="quick">' + IC_DOWNLOAD + '<span>Quick</span></button>' +
        '<button class="btn secondary" data-act="tex">' + IC_FILE_DOWN + '<span>GLB + PNG</span></button>' +
        '<button class="btn secondary" data-act="zip">' + IC_ZIP + '<span>ZIP</span></button></div>';
      const saveBtn = card.querySelector('[data-act="save"]');
      const quickBtn = card.querySelector('[data-act="quick"]');
      if (saveBtn) saveBtn.addEventListener('click', () => saveAs(item, saveBtn));
      if (quickBtn) quickBtn.addEventListener('click', () => quick(item, quickBtn));
      const texBtn = card.querySelector('[data-act="tex"]');
      if (texBtn) texBtn.addEventListener('click', () => glbPlusPng(item, texBtn));
      const zipBtn = card.querySelector('[data-act="zip"]');
      if (zipBtn) zipBtn.addEventListener('click', () => zipBundle(item, zipBtn));
      listEl.appendChild(card);
    });
  }

  // Fetch the buffer from the frame that reported it, in base64 chunks.
  function b64ToBytes(b64) {
    var bin = atob(b64 || "");
    var len = bin.length;
    var out = new Uint8Array(len);
    for (var i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function getBuffer(item) {
    const payload = { type: 'M2G_GET_BUFFER', id: item.id };
    const frames = [];
    if (item.frameId != null && frames.indexOf(item.frameId) === -1) frames.push(item.frameId);
    if (frames.indexOf(0) === -1) frames.push(0);
    frames.push(null);
    let lastErr = new Error('Download failed');
    for (const fid of frames) {
      try {
        const opts = (fid == null) ? {} : { frameId: fid };
        const meta = await sendMsg(payload, opts, 35000);
        if (!meta || !meta.ok) {
          const em = String((meta && meta.error) || 'Download failed');
          if (em.indexOf('not-mine') !== -1) { lastErr = new Error('Model is in another frame - trying next...'); continue; }
          lastErr = new Error(em); continue;
        }
        const total = meta.chunks | 0;
        if (!total || total < 1) { lastErr = new Error('Empty model data'); continue; }
        const parts = new Array(total);
        for (let i = 0; i < total; i++) {
          const ch = await sendMsg({ type: 'M2G_GET_CHUNK', id: item.id, index: i }, opts, 35000);
          if (!ch || !ch.ok) throw new Error(String((ch && ch.error) || ('chunk ' + i + ' failed')));
          parts[i] = b64ToBytes(ch.data);
        }
        let len = 0;
        for (const p of parts) len += p.length;
        const out = new Uint8Array(len);
        let off = 0;
        for (const p of parts) { out.set(p, off); off += p.length; }
        if (meta.size && out.length !== meta.size) throw new Error('Incomplete model data (' + out.length + '/' + meta.size + ')');
        return { buffer: out.buffer, filename: meta.filename || item.filename || 'model.glb' };
      } catch (e) { lastErr = e; continue; }
    }
    throw lastErr;
  }

  // Parse just the JSON chunk of a GLB (material -> texture-slot mapping).
  function parseGLBDoc(buffer) {
    try {
      var dv = new DataView(buffer);
      if (dv.getUint32(0, true) !== 0x46546C67) return null;
      var off = 12;
      while (off + 8 <= dv.byteLength) {
        var clen = dv.getUint32(off, true);
        var ctype = dv.getUint32(off + 4, true);
        off += 8;
        if (ctype === 0x4E4F534A) {
          try { return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, off, clen))); }
          catch (e) { return null; }
        }
        off += clen;
      }
    } catch (e) {}
    return null;
  }

  // Extract embedded images from a GLB (JSON chunk -> images/bufferViews -> BIN chunk).
  function parseGLBImages(buffer) {
    var out = [];
    try {
      var dv = new DataView(buffer);
      if (dv.getUint32(0, true) !== 0x46546C67) return out;
      var off = 12;
      var json = null, binOff = 0, binLen = 0;
      while (off + 8 <= dv.byteLength) {
        var clen = dv.getUint32(off, true);
        var ctype = dv.getUint32(off + 4, true);
        off += 8;
        if (ctype === 0x4E4F534A) {
          try { json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, off, clen))); } catch (e) {}
        } else if (ctype === 0x004E4942) { binOff = off; binLen = clen; }
        off += clen;
      }
      if (!json || !json.images || !binLen) return out;
      var views = json.bufferViews || [];
      for (var i = 0; i < json.images.length; i++) {
        var im = json.images[i];
        if (im.bufferView != null && views[im.bufferView]) {
          var bv = views[im.bufferView];
          var start = binOff + (bv.byteOffset || 0);
          var slice = new Uint8Array(buffer, start, bv.byteLength);
          out.push({ bytes: new Uint8Array(slice), mime: im.mimeType || "image/png", name: im.name || ("texture" + i) });
        } else if (im.uri && im.uri.indexOf("data:") === 0) {
          var m = im.uri.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
          if (m) {
            var raw2 = null;
            if (m[2]) {
              var s = atob(m[3]);
              raw2 = new Uint8Array(s.length);
              for (var k = 0; k < s.length; k++) raw2[k] = s.charCodeAt(k);
            } else {
              var u = decodeURIComponent(m[3]);
              raw2 = new Uint8Array(u.length);
              for (var k2 = 0; k2 < u.length; k2++) raw2[k2] = u.charCodeAt(k2);
            }
            out.push({ bytes: raw2, mime: m[1] || "image/png", name: im.name || ("texture" + i) });
          }
        }
      }
    } catch (e) {}
    return out;
  }

  // Normalize any image to PNG via canvas; falls back to raw bytes.
  async function toPNGBlob(bytes, mime) {
    var raw = new Blob([bytes], { type: mime });
    if (mime === "image/png") return raw;
    try {
      var bmp = await createImageBitmap(raw);
      var cv = document.createElement("canvas");
      cv.width = bmp.width; cv.height = bmp.height;
      cv.getContext("2d").drawImage(bmp, 0, 0);
      try { bmp.close(); } catch (e) {}
      var png = await new Promise(function (res) { cv.toBlob(function (b) { res(b); }, "image/png"); });
      if (png) return png;
    } catch (e) {}
    return raw;
  }

  function dlBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var p = null;
    if (chrome.downloads) p = chrome.downloads.download({ url: url, filename: filename, saveAs: false });
    else {
      var a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      p = Promise.resolve();
    }
    return p.then(function () { setTimeout(function () { URL.revokeObjectURL(url); }, 60000); });
  }

  // One click: GLB plus every embedded texture as extra PNG file.
  async function glbPlusPng(item, btn) {
    lock(btn, true, 'Loading...');
    try {
      const got = await getBuffer(item);
      if (!(got.buffer instanceof ArrayBuffer)) throw new Error("Incomplete model data - reload the Meshy tab, reopen the model, then try again.");
      if (got.buffer.byteLength < 12 || new DataView(got.buffer, 0, 4).getUint32(0, true) !== 0x46546C67) throw new Error("No GLB data received - reload the Meshy tab, reopen the model, then try again.");
      var base = 'model';
      await dlBlob(new Blob([got.buffer], { type: 'model/gltf-binary' }), base + '.glb');
      var imgs = parseGLBImages(got.buffer);
      if (!imgs.length) { notice('GLB saved. No embedded textures found - colors may be vertex colors only.', true); return; }
      for (var i = 0; i < imgs.length; i++) {
        var blob = await toPNGBlob(imgs[i].bytes, imgs[i].mime);
        var ext = (blob.type === "image/png") ? ".png" : (imgs[i].mime === "image/jpeg" ? ".jpg" : ".bin");
        await dlBlob(blob, 'texture' + i + ext);
      }
      notice('Saved ' + base + '.glb plus ' + imgs.length + ' texture file(s).', true);
    } catch (err) {
      notice('GLB + PNG failed: ' + err.message);
    } finally {
      lock(btn, false);
    }
  }

  // One click: model.glb + every embedded texture as PNG, bundled in one .zip.
  async function zipBundle(item, btn) {
    if (typeof M2GZip === 'undefined' || !M2GZip.create) {
      notice('ZIP engine missing - reload the extension (chrome://extensions).');
      return;
    }
    lock(btn, true, 'Loading...');
    try {
      const got = await getBuffer(item);
      if (!(got.buffer instanceof ArrayBuffer)) throw new Error("Incomplete model data - reload the Meshy tab, reopen the model, then try again.");
      if (got.buffer.byteLength < 12 || new DataView(got.buffer, 0, 4).getUint32(0, true) !== 0x46546C67) throw new Error("No GLB data received - reload the Meshy tab, reopen the model, then try again.");
      var base = fixName(item.filename || got.filename || 'model.glb').replace(/\.glb$/i, '');
      var doc = parseGLBDoc(got.buffer);
      var slotMap = {};
      try { if (doc && M2GZip.glbImageSlots) slotMap = M2GZip.glbImageSlots(doc) || {}; } catch (e) {}
      var zw = M2GZip.create();
      zw.add(base + '.glb', new Uint8Array(got.buffer));
      var imgs = parseGLBImages(got.buffer);
      var entries = [];
      for (var i = 0; i < imgs.length; i++) {
        var blob = await toPNGBlob(imgs[i].bytes, imgs[i].mime);
        var ext = (blob.type === "image/png") ? ".png" : (imgs[i].mime === "image/jpeg" ? ".jpg" : ".bin");
        var slots = slotMap[i] || [];
        var fname = M2GZip.zipName(base, slots, i, ext);
        var ab = new Uint8Array(await blob.arrayBuffer());
        zw.add(fname, ab);
        entries.push({ file: fname, slots: slots });
      }
      zw.add('fixer.json', new TextEncoder().encode(M2GZip.fixerManifest(base, base + '.glb', entries)));
      var zipBytes = zw.finish();
      await dlBlob(new Blob([zipBytes], { type: 'application/zip' }), base + '.zip');
      notice('Saved ' + base + '.zip (glb' + (imgs.length ? ' + ' + imgs.length + ' texture(s)' : ', no embedded textures') + ' + fixer.json).', true);
    } catch (err) {
      notice('ZIP failed: ' + err.message);
    } finally {
      lock(btn, false);
    }
  }

  function lock(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = label || 'Working...'; }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }

  async function saveAs(item, btn) {
    lock(btn, true, 'Picker...');
    try {
      let handle = null;
      if (window.showSaveFilePicker) {
        try {
          handle = await window.showSaveFilePicker({
            suggestedName: 'model.glb',
            types: [{ description: 'GLB 3D model (*.glb)', accept: { 'model/gltf-binary': ['.glb'] } }],
            excludeAcceptAllOption: true
          });
        } catch (pickErr) {
          if (pickErr && pickErr.name === 'AbortError') { lock(btn, false); return; }
          handle = null;
        }
      }
      lock(btn, true, 'Loading model...');
      const got = await getBuffer(item);
      if (!(got.buffer instanceof ArrayBuffer)) throw new Error("Incomplete model data - reload the Meshy tab, reopen the model, then try again.");
      if (got.buffer.byteLength < 12 || new DataView(got.buffer, 0, 4).getUint32(0, true) !== 0x46546C67) throw new Error("No GLB data received - reload the Meshy tab, reopen the model, then try again.");
      const blob = new Blob([got.buffer], { type: 'model/gltf-binary' });
      if (handle) {
        lock(btn, true, 'Writing file...');
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        try {
          var hn = String((handle && handle.name) || '');
          if (!/\.glb$/i.test(hn)) notice('Saved as ' + hn + ' - append .glb if the extension is missing.');
          else notice('Saved! Check the chosen folder.', true);
        } catch (e) {
          notice('Saved!', true);
        }
      } else {
        const url = URL.createObjectURL(blob);
        try {
          await chrome.downloads.download({ url, filename: 'model.glb', saveAs: true });
          notice('Save dialog opened - pick a folder there.', true);
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        }
      }
    } catch (err) {
      notice('Save failed: ' + err.message);
    } finally {
      lock(btn, false);
    }
  }

  async function quick(item, btn) {
    lock(btn, true, 'Loading...');
    try {
      const got = await getBuffer(item);
      if (!(got.buffer instanceof ArrayBuffer)) throw new Error("Incomplete model data - reload the Meshy tab, reopen the model, then try again.");
      if (got.buffer.byteLength < 12 || new DataView(got.buffer, 0, 4).getUint32(0, true) !== 0x46546C67) throw new Error("No GLB data received - reload the Meshy tab, reopen the model, then try again.");
      const blob = new Blob([got.buffer], { type: 'model/gltf-binary' });
      const url = URL.createObjectURL(blob);
      try {
        if (chrome.downloads) {
          await chrome.downloads.download({ url, filename: 'model.glb', saveAs: false });
        } else {
          const a = document.createElement('a');
          a.href = url; a.download = 'model.glb';
          document.body.appendChild(a); a.click(); a.remove();
        }
        notice('model.glb saved to Downloads.', true);
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } catch (err) {
      notice('Download failed: ' + err.message);
    } finally {
      lock(btn, false);
    }
  }

  async function clearAll() {
    notice(null);
    try {
      if (TAB && TAB.id != null) {
        // Broadcast: alle Frames leeren ihren Speicher.
        await chrome.tabs.sendMessage(TAB.id, { type: 'M2G_CLEAR' }).catch(() => null);
        await chrome.runtime.sendMessage({ type: 'M2G_TAB_CLEARED', tabId: TAB.id }).catch(() => null);
      }
    } catch (e) {}
    ITEMS = [];
    setPill('Meshy tab', 'ok');
    render();
  }

  async function init() {
    on('refresh', 'click', load);
    on('reloadTab', 'click', reloadTab);
    on('clear', 'click', clearAll);
    on('openMeshy', 'click', openMeshy);
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      TAB = tabs && tabs[0];
    } catch (e) { TAB = null; }
    if (!TAB) { setPill('no tab', 'warn'); notice('Active tab not found.'); return; }
    await load();
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'session' || !TAB || TAB.id == null) return;
        if (changes['m2g_tab_' + TAB.id]) softRefresh();
      });
    } catch (e) {}
    try {
      POLL = setInterval(softRefresh, 2500);
      window.addEventListener('unload', () => { try { clearInterval(POLL); } catch (e) {} });
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
