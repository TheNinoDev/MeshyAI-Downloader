/* M2GZip - minimal stored (no-compression) ZIP writer, zero dependencies.
 * Classic script (MV3 CSP-safe, no modules/CDN). Works in popup + node.
 * Usage: var zw = M2GZip.create(); zw.add("model.glb", uint8); var out = zw.finish(); // Uint8Array
 * Finish wraps new Blob([out.buffer], {type:"application/zip"}) on the caller side.
 */
var M2GZip = (function () {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Array(256), c, k, n;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(data) {
    var c = 0xFFFFFFFF, i;
    for (i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    // very old fallback: ASCII-subset only
    var out = [], i, ch;
    for (i = 0; i < s.length; i++) {
      ch = s.charCodeAt(i);
      out.push(ch & 0xFF);
    }
    return new Uint8Array(out);
  }

  function Writer() {
    this._chunks = [];
    this._central = [];
    this._offset = 0;
    this._count = 0;
  }

  Writer.prototype._push = function (arr) {
    this._chunks.push(arr);
    this._offset += arr.length;
  };

  Writer.prototype.add = function (name, data) {
    if (!(data instanceof Uint8Array)) throw new Error('M2GZip.add needs Uint8Array');
    var nm = utf8(String(name));
    var crc = crc32(data);
    var localOff = this._offset;
    var lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034B50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 filenames
    lh.setUint16(8, 0, true);      // stored
    lh.setUint16(10, 0, true); lh.setUint16(12, 0, true); // dos time/date
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nm.length, true);
    lh.setUint16(28, 0, true);
    this._push(new Uint8Array(lh.buffer));
    this._push(nm);
    this._push(data);
    var ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014B50, true);
    ch.setUint16(4, 63, true); // made by unix
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, 0, true); ch.setUint16(14, 0, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nm.length, true);
    ch.setUint16(30, 0, true); ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
    ch.setUint32(38, (0x20 << 16) >>> 0, true); // regular file attrs
    ch.setUint32(42, localOff, true);
    this._central.push({ head: new Uint8Array(ch.buffer), name: nm });
    this._count++;
    return this;
  };

  Writer.prototype.finish = function () {
    var centralOff = this._offset, centralSize = 0, i, e;
    for (i = 0; i < this._central.length; i++) {
      e = this._central[i];
      this._push(e.head);
      this._push(e.name);
      centralSize += e.head.length + e.name.length;
    }
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054B50, true);
    end.setUint16(4, 0, true); end.setUint16(6, 0, true);
    end.setUint16(8, this._count, true);
    end.setUint16(10, this._count, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, centralOff, true);
    end.setUint16(20, 0, true);
    this._push(new Uint8Array(end.buffer));
    var out = new Uint8Array(this._offset), off = 0;
    for (i = 0; i < this._chunks.length; i++) {
      out.set(this._chunks[i], off);
      off += this._chunks[i].length;
    }
    return out;
  };

  // glTF material -> image-slot map: { imageIndex: ["albedo","roughness",...] }.
  // The combined ORM texture maps to BOTH roughness and metalness (the fixer
  // splits green/blue channels). Pure function over the parsed JSON doc.
  function glbImageSlots(doc) {
    var out = {};
    function add(idx, slot) {
      if (idx == null) return;
      if (!out[idx]) out[idx] = [];
      if (out[idx].indexOf(slot) === -1) out[idx].push(slot);
    }
    try {
      var mats = (doc && doc.materials) || [];
      for (var m = 0; m < mats.length; m++) {
        var mat = mats[m] || {};
        var pbr = mat.pbrMetallicRoughness || {};
        if (pbr.baseColorTexture) add(pbr.baseColorTexture.index, 'albedo');
        if (pbr.metallicRoughnessTexture) {
          add(pbr.metallicRoughnessTexture.index, 'roughness');
          add(pbr.metallicRoughnessTexture.index, 'metalness');
        }
        if (mat.normalTexture) add(mat.normalTexture.index, 'normal');
        if (mat.occlusionTexture) add(mat.occlusionTexture.index, 'occlusion');
        if (mat.emissiveTexture) add(mat.emissiveTexture.index, 'emissive');
      }
    } catch (e) {}
    return out;
  }

  function sanitize(name) {
    return String(name).replace(/[\\/:*?"<>|]+/g, '_');
  }

  // Fixer-friendly filename: semantic when the slot is known, textureN otherwise.
  function zipName(base, slots, fallbackIdx, ext) {
    base = sanitize(base || 'model');
    slots = slots || [];
    function has(s) { return slots.indexOf(s) !== -1; }
    if (has('albedo')) return base + '_albedo' + ext;
    if (has('normal')) return base + '_normal' + ext;
    if (has('roughness') && has('metalness')) return base + '_roughness_metalness' + ext;
    if (has('roughness')) return base + '_roughness' + ext;
    if (has('metalness')) return base + '_metalness' + ext;
    if (has('emissive')) return base + '_emissive' + ext;
    if (has('occlusion')) return base + '_occlusion' + ext;
    return 'texture' + fallbackIdx + ext;
  }

  // fixer.json: exact model->maps assignment so the fixer needs zero guessing.
  // entries: [{file, slots}].
  function fixerManifest(base, glbName, entries, extra) {
    var maps = {};
    (entries || []).forEach(function (e) {
      (e.slots || []).forEach(function (s) {
        if (['albedo', 'normal', 'roughness', 'metalness', 'emissive', 'occlusion'].indexOf(s) !== -1) {
          if (!maps[s]) maps[s] = e.file;
        }
      });
    });
    var doc = {
      tool: 'Meshy2GLB', zipFormat: 1, model: glbName, maps: maps,
      exportedAt: new Date().toISOString()
    };
    if (extra) doc.extra = extra;
    return JSON.stringify(doc, null, 2);
  }

  return {
    create: function () { return new Writer(); },
    glbImageSlots: glbImageSlots,
    zipName: zipName,
    fixerManifest: fixerManifest
  };
})();

if (typeof module !== 'undefined' && module.exports) { module.exports = M2GZip; }
