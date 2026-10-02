// Meshy2GLB v1.2.0 - service worker: Capture-Metadaten pro Tab (aus allen
// Frames gemergt) + Badge + PWF Auth Lizenz-Gate. Die Binaerdaten bleiben in
// der Seite; das Popup holt sie gezielt per frameId ab.
// OHNE gueltige Lizenz passiert nichts: Captures werden verworfen und die
// Liste bleibt leer, bis M2G_LICENSE_ACTIVATE erfolgreich war.
const keyFor = (tabId) => 'm2g_tab_' + tabId;

// ---- PWF Auth Lizenz (https://pwfauth.com/), HWID-gebunden: 1 Geraet pro Key ----
const PWF_APP_SECRET = '1775b3f2f00d4911663706a04b7543ba2078b34b0b01eaae39b41cb07c3b8ba6';
const PWF_APP_ID = '945a2a22-2fa5-419f-9f79-c680c587eb01'; // Referenz (login.php braucht nur Secret+Envelope)
// check-key.php prueft nur "existiert der Key" (kein HWID, kein Lock) –
// darum läuft alles ueber login.php (Session+HWID-Binding, max_devices vom
// Server erzwungen) + heartbeat.php (Kill-Switch in Minuten) im
// AES-256-CBC+HMAC-SHA256-Envelope. Zweitgeraet mit selbem Key wirft das
// Erstgeraet per Heartbeat raus (aelteste Session wird retired).
const PWF_LOGIN_URL = 'https://pwfauth.com/api/auth/login.php';
const PWF_HEARTBEAT_URL = 'https://pwfauth.com/api/auth/heartbeat.php';
const PWF_LOGOUT_URL = 'https://pwfauth.com/api/auth/logout.php';
const PWF_HWID_KEY = 'm2g_hwid';
const PWF_LICENSE_STORAGE_KEY = 'm2g_license';
const PWF_RECHECK_MS = 12 * 60 * 60 * 1000; // alle 12h online nachpruefen
const PWF_OFFLINE_GRACE_MS = 72 * 60 * 60 * 1000; // offline max. 72h weiter erlauben

// Tamper-evidence fuer den Lizenz-Cache: hand-editierte Eintraege in
// chrome.storage.local (einfachster Bypass ohne Key) werden erkannt und
// geloescht. Kein echter Schutz gegen Code-Leser (Secret liegt im selben
// File), hebt aber die Huerde von "eine Konsolen-Zeile" auf "Code lesen +
// Hash faken". Echte Key-Sharing-Abwehr braucht HWID-Binding (login.php).
async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function licenseSig(key, expiresAt, lastCheck, hwid, sessionId) {
  return sha256Hex(PWF_APP_SECRET + '|' + String(key) + '|' + String(expiresAt == null ? '' : expiresAt) + '|' + String(lastCheck) + '|' + String(hwid || '') + '|' + String(sessionId || ''));
}

async function getLicense() {
  try {
    const got = await chrome.storage.local.get(PWF_LICENSE_STORAGE_KEY);
    return got[PWF_LICENSE_STORAGE_KEY] || null;
  } catch (e) { return null; }
}

async function setLicense(obj) {
  try { await chrome.storage.local.set({ [PWF_LICENSE_STORAGE_KEY]: obj }); } catch (e) {}
}

async function clearLicense() {
  try { await chrome.storage.local.remove(PWF_LICENSE_STORAGE_KEY); } catch (e) {}
}

function maskKey(k) {
  const s = String(k || '');
  if (s.length <= 8) return '****';
  return s.slice(0, 4) + '…' + s.slice(-4);
}

// Stabile Geraete-ID pro Browser-Profil (HWID-Ersatz: Extensionen sehen
// keine echte Hardware). Neuinstallation/neues Profil = neues Geraet und
// verbraucht bei max_devices=1 den Slot des alten (aelteste Session retired).
async function getHWID() {
  try {
    const got = await chrome.storage.local.get(PWF_HWID_KEY);
    if (got[PWF_HWID_KEY]) return String(got[PWF_HWID_KEY]);
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [PWF_HWID_KEY]: id });
    return id;
  } catch (e) {
    return 'tmp-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
  }
}

// Envelope-Krypto (Rezept aus den PWF-Docs, live gegen den Server verifiziert):
// enc_key=SHA256("enc:"+secret), mac_key=SHA256("mac:"+secret),
// p=base64(IV||AES-256-CBC), t=unix-sec, s=HMAC-SHA256_hex(p+t).
let _pwfAesKey = null, _pwfHmacKey = null;
async function pwfKeys() {
  if (_pwfAesKey && _pwfHmacKey) return { aes: _pwfAesKey, hmac: _pwfHmacKey };
  const te = new TextEncoder();
  const encRaw = await crypto.subtle.digest('SHA-256', te.encode('enc:' + PWF_APP_SECRET));
  const macRaw = await crypto.subtle.digest('SHA-256', te.encode('mac:' + PWF_APP_SECRET));
  _pwfAesKey = await crypto.subtle.importKey('raw', encRaw, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
  _pwfHmacKey = await crypto.subtle.importKey('raw', macRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return { aes: _pwfAesKey, hmac: _pwfHmacKey };
}
function b64encBytes(bytes) {
  let s = '';
  const C = 32768;
  for (let i = 0; i < bytes.length; i += C) s += String.fromCharCode.apply(null, bytes.subarray(i, i + C));
  return btoa(s);
}
function b64decStr(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function hexencBytes(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hexdecStr(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}
async function pwfSeal(obj) {
  const keys = await pwfKeys();
  const te = new TextEncoder();
  const t = Math.floor(Date.now() / 1000);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: iv }, keys.aes, te.encode(JSON.stringify(obj))));
  const joined = new Uint8Array(16 + ct.length);
  joined.set(iv, 0); joined.set(ct, 16);
  const p = b64encBytes(joined);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', keys.hmac, te.encode(p + String(t))));
  return { p: p, t: t, s: hexencBytes(sig) };
}
async function pwfOpen(env) {
  if (!env || typeof env.p !== 'string' || typeof env.s !== 'string' || !isFinite(Number(env.t))) throw new Error('Bad license envelope');
  const t = Number(env.t);
  if (Math.abs(Date.now() / 1000 - t) > 300) throw new Error('License clock skew');
  const keys = await pwfKeys();
  const te = new TextEncoder();
  const ok = await crypto.subtle.verify('HMAC', keys.hmac, hexdecStr(String(env.s)), te.encode(env.p + String(env.t)));
  if (!ok) throw new Error('Bad license signature');
  const raw = b64decStr(env.p);
  if (raw.length < 17) throw new Error('Bad license payload');
  const pt = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: raw.slice(0, 16) }, keys.aes, raw.slice(16));
  return JSON.parse(new TextDecoder().decode(pt));
}
// Ein Call: Header (App-ID) + Envelope-Body, Antwort-Envelope oeffnen.
// HINWEIS: login.php braucht BEIDES (ohne Header: 401 Missing X-App-Secret).
async function pwfCall(url, obj) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-App-Secret': PWF_APP_SECRET },
    body: JSON.stringify(await pwfSeal(obj))
  });
  const http = res.status;
  let env = null;
  try { env = await res.json(); } catch (e) { throw new Error('Bad license server response (HTTP ' + http + ')'); }
  try {
    const data = await pwfOpen(env);
    data._http = http;
    try { console.log('[Meshy2GLB] license:', String(url.split('/').pop()), http, JSON.stringify(data).slice(0, 300)); } catch (e) {}
    return data;
  } catch (e) {
    if (env && (env.message || env.detail || env.error_code)) {
      return { success: false, error_code: env.error_code, message: env.message || env.detail, _http: http };
    }
    throw e;
  }
}

function friendlyLicenseError(data) {
  const code = String((data && data.error_code) || '');
  const msg = String((data && (data.message || data.detail)) || '');
  if (code === 'INVALID_KEY') return 'Key not found. Check the key for typos.';
  if (code === 'EXPIRED') return 'This license has expired.';
  if (code === 'BANNED') return 'This license has been banned.';
  if (code === 'PAUSED') return 'This license is paused. Contact support.';
  if (code === 'HWID_MISMATCH') return 'This key is already active on another device (1 device allowed). Open it there, or ask the seller for a HWID reset.';
  if (code === 'SESSION_EXPIRED' || code === 'SESSION_MISMATCH') return 'Session ended – this key was activated on another device. Re-activate here to take over.';
  if (code === 'MAINTENANCE') return 'License server is in maintenance. Try again later.';
  if (msg) return msg;
  return 'License invalid.';
}

async function activateLicense(rawKey) {
  const licenseKey = String(rawKey || '').trim().replace(/\s+/g, '');
  if (!licenseKey) return { ok: false, error: 'Please enter a license key.' };
  const hwid = await getHWID();
  let data;
  try {
    data = await pwfCall(PWF_LOGIN_URL, { license_key: licenseKey, hwid: hwid });
  } catch (e) {
    try { console.warn('[Meshy2GLB] license activate network fail:', String((e && e.message) || e)); } catch (e2) {}
    return { ok: false, error: 'License server unreachable (' + String((e && e.message) || e) + '). Check your connection and try again.' };
  }
  // login.php antwortet {success, session_id, user:{...}, heartbeat_interval}
  const valid = !!(data && data.success && data.session_id);
  if (valid) {
    const info = (data && data.user) || {};
    let expiresAt = null;
    try {
      if (info.expires_at) {
        const t = Date.parse(info.expires_at);
        if (!isNaN(t)) expiresAt = t;
      }
    } catch (e) {}
    const now = Date.now();
    const hb = Math.max(30, parseInt(data.heartbeat_interval, 10) || 30);
    const sig = await licenseSig(licenseKey, expiresAt, now, hwid, data.session_id);
    await setLicense({
      key: licenseKey,
      hwid: hwid,
      session_id: data.session_id,
      lastCheck: now,
      cachedValid: true,
      expiresAt: expiresAt,
      status: String(info.status || 'active'),
      heartbeatInterval: hb,
      sig: sig
    });
    setupHeartbeatAlarm(hb);
    return { ok: true, licensed: true, expiresAt: expiresAt, status: String(info.status || 'active') };
  }
  // invalid -> alte Lizenz entfernen, damit nichts mehr geht
  await clearLicense();
  const dbg = ' (code=' + String((data && data.error_code) || 'n/a') + ' http=' + String((data && data._http) || 'n/a') + ' msg=' + String((data && (data.message || data.detail)) || 'n/a') + ')';
  return { ok: false, error: friendlyLicenseError(data) + dbg, error_code: (data && data.error_code) || 'INVALID' };
}

// opts.forceOnline: auch bei frischem Cache einen Heartbeat senden (Downloads,
// Heartbeat-Alarm). Bei Netzfehler Grace-Periode, damit ehrliche Offline-Nutzer
// nicht ausgesperrt werden – ein revoked/entwendeter Key mit Internet stirbt sofort.
// Zweitgeraet- Uebernahme: login dort retired DIESE Session -> naechster
// Heartbeat/Download hier schlaegt mit SESSION_* fehl -> locked.
async function isLicensed(opts) {
  opts = opts || {};
  const lic = await getLicense();
  if (!lic || !lic.key || !lic.cachedValid || !lic.session_id) {
    return { licensed: false, reason: 'no-key' };
  }
  const now = Date.now();
  if (lic.expiresAt && now > lic.expiresAt) {
    await clearLicense();
    return { licensed: false, reason: 'expired' };
  }
  // Integritaet: Cache ohne/mit falschem Hash = von Hand reingeschrieben.
  try {
    const exp = await licenseSig(lic.key, lic.expiresAt == null ? null : lic.expiresAt, lic.lastCheck, lic.hwid, lic.session_id);
    if (!lic.sig || lic.sig !== exp) {
      await clearLicense();
      try { console.warn('[Meshy2GLB] license cache tampered, cleared'); } catch (e) {}
      return { licensed: false, reason: 'tampered', message: 'License data tampered. Please re-activate.' };
    }
  } catch (e) {
    return { licensed: false, reason: 'no-key' };
  }
  if (!opts.forceOnline && now - (lic.lastCheck || 0) < PWF_RECHECK_MS) {
    return { licensed: true, cached: true, offline: false, expiresAt: lic.expiresAt || null, keyMasked: maskKey(lic.key), hwidShort: String(lic.hwid || '').slice(0, 8) };
  }
  // Heartbeat = Session lebt noch? (Ban/Pause/Expire/Fremdgeraet -> nein)
  try {
    const data = await pwfCall(PWF_HEARTBEAT_URL, { session_id: lic.session_id, license_key: lic.key });
    if (data && data.success) {
      const sig = await licenseSig(lic.key, lic.expiresAt || null, now, lic.hwid, lic.session_id);
      await setLicense(Object.assign({}, lic, { lastCheck: now, cachedValid: true, sig: sig }));
      return { licensed: true, cached: false, offline: false, expiresAt: lic.expiresAt || null, keyMasked: maskKey(lic.key), hwidShort: String(lic.hwid || '').slice(0, 8) };
    }
    await clearLicense();
    try { chrome.alarms.clear('m2g-heartbeat').catch(() => {}); } catch (e) {}
    return { licensed: false, reason: String((data && data.error_code) || 'invalid').toLowerCase(), message: friendlyLicenseError(data) };
  } catch (e) {
    // offline: Grace-Periode erlauben, aber als offline markieren
    if (now - (lic.lastCheck || 0) < PWF_OFFLINE_GRACE_MS) {
      return { licensed: true, cached: true, offline: true, expiresAt: lic.expiresAt || null, keyMasked: maskKey(lic.key), hwidShort: String(lic.hwid || '').slice(0, 8) };
    }
    return { licensed: false, reason: 'offline', message: 'License server unreachable and offline grace expired. Reconnect to re-validate.' };
  }
}

// Heartbeat-Alarm im Server-Intervall (Default 30s): Session am Leben halten
// UND Kill-Switch durchsetzen (Ban/Pause/Fremdgeraet greift in Minuten).
function setupHeartbeatAlarm(sec) {
  try {
    const mins = Math.max(0.5, (parseInt(sec, 10) || 30) / 60);
    chrome.alarms.create('m2g-heartbeat', { periodInMinutes: mins });
  } catch (e) {}
}
try { chrome.alarms.clear('m2g-license-recheck').catch(() => {}); } catch (e) {}
try {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === 'm2g-heartbeat') {
      isLicensed({ forceOnline: true }).catch(() => {});
    }
  });
} catch (e) {}
// Nach SW-Neustart Alarm wiederherstellen, falls lizenziert.
try {
  getLicense().then((lic) => {
    if (lic && lic.cachedValid && lic.session_id) setupHeartbeatAlarm(lic.heartbeatInterval || 30);
  }).catch(() => {});
} catch (e) {}

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
    if (msg && (msg.type === 'M2G_LICENSE_STATUS')) {
      const st = await isLicensed({ forceOnline: !!(msg && msg.online) });
      sendResponse(Object.assign({ ok: true }, st));
      return;
    } else if (msg && msg.type === 'M2G_LICENSE_ACTIVATE') {
      const r = await activateLicense(msg.license_key);
      sendResponse(r);
      return;
    } else if (msg && msg.type === 'M2G_LICENSE_LOGOUT') {
      // Server-Session sauber schliessen (best effort), dann alles vergessen.
      try {
        const lic = await getLicense();
        if (lic && lic.session_id) {
          await pwfCall(PWF_LOGOUT_URL, { session_id: lic.session_id }).catch(() => null);
        }
      } catch (e) {}
      try { chrome.alarms.clear('m2g-heartbeat').catch(() => {}); } catch (e) {}
      await clearLicense();
      // Captures beim Logout vergessen, damit ohne Lizenz nichts uebrig bleibt.
      try {
        const all = await chrome.storage.session.get(null);
        const rm = Object.keys(all || {}).filter((k) => k.indexOf('m2g_tab_') === 0);
        if (rm.length) await chrome.storage.session.remove(rm);
      } catch (e) {}
      try {
        const tabs = await chrome.tabs.query({});
        for (const t of (tabs || [])) {
          try { if (t && t.id != null) await chrome.action.setBadgeText({ tabId: t.id, text: '' }); } catch (e) {}
        }
      } catch (e) {}
      sendResponse({ ok: true });
      return;
    }
    if (msg && msg.type === 'M2G_CAPTURE') {
      const lic = await isLicensed();
      if (!lic.licensed) { try { sendResponse({ ok: false, error: 'unlicensed' }); } catch (e) {} return; }
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
    } else if (msg && msg.type === "M2G_TAKEOVER") {
      // v1.0.17: deprecated - Meshy-button downloads stay native in the page
      // (ArrayBuffer via extension messaging corrupted bytes to "[object Object]").
      try { sendResponse({ ok: true, native: true }); } catch (e2) {}
    } else if (msg && msg.type === 'M2G_GET_TAB_CAPTURES') {
      const lic = await isLicensed();
      if (!lic.licensed) { sendResponse({ ok: false, error: 'unlicensed', licensed: false }); return; }
      sendResponse({ ok: true, captures: await loadCaptures(msg.tabId), licensed: true, offline: !!lic.offline });
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
