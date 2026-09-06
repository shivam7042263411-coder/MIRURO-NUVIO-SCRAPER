/*
 * Animelok (flixcloud) provider for Nuvio.
 *
 * Hard-subbed (burned-in subtitle) anime HLS from animelok.live, served
 * through flixcloud (https://flixcloud.cc). Each episode's stream is
 * encrypted with a small per-token WebAssembly kernel plus PBKDF2 +
 * AES-256-CBC. Nuvio's engine has neither WebAssembly nor WebCrypto, so
 * this provider ships pure-ES5 implementations of a tiny wasm interpreter,
 * SHA-256, HMAC-SHA256, PBKDF2, AES-256-CBC, base64 and the flixcloud
 * page-data extraction.
 *
 * Chain for one episode:
 *   animelok.live/api/flix/{anilistId}/{ep}
 *     -> server HD-1 sub (softsub:false = hard subs)
 *     -> dataLink https://flixcloud.cc/e/{tok}?v=1  (embed page)
 *     -> route data: obfuscation_seed, obfuscated_crypto_data, w_payload,
 *        token field, keyFrag2 field
 *     -> GET {dataLink origin}/api/m3u8/{L}  -> ciphertext + key material
 *     -> wasm kn() + PBKDF2 + AES-256-CBC -> m3u8 URL
 */
var FLIX_ORIGIN = "https://flixcloud.cc";
var ANIMELOK_API = "https://animelok.live/api/flix";

/* Pre-seeded Kitsu-AniList ids for popular titles (see vidnest.js). */
var LOCAL_ANILIST = {
  "tv:94664": "108465",    /* Mushoku Tensei */
  "kitsu:42323": "108465", /* Mushoku Tensei */
  "kitsu:12": "21",        /* One Piece */
  "tv:37854": "21",        /* One Piece */
  "tv:209867": "154587",   /* Frieren */
  "tv:1429": "16498",      /* Attack on Titan */
  "tv:85937": "101922"     /* Demon Slayer */
};

function deadline(ms) {
  if (typeof setTimeout === "function") {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }
  var end = Date.now() + ms;
  function tick(resolve) {
    if (Date.now() >= end) { resolve(); } else {
      Promise.resolve().then(function () { tick(resolve); });
    }
  }
  return new Promise(function (resolve) { tick(resolve); });
}

function safeParseJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function fetchBody(url, ms, headers) {
  return new Promise(function (resolve) {
    var done = false;
    function out(s, b) { if (!done) { done = true; resolve({ status: s, body: b }); } }
    deadline(ms).then(function () { out(0, ""); });
    if (typeof fetch !== "function") { out(-1, ""); return; }
    fetch(url, { method: "GET", headers: headers || { "User-Agent": "Mozilla/5.0" } })
      .then(function (r) {
        var st = r && typeof r.status === "number" ? r.status : 0;
        if (r && typeof r.text === "function") {
          r.text().then(function (t) { out(st, String(t || "")); });
        } else {
          out(st, "");
        }
      })
      .catch(function () { out(-2, ""); });
  });
}

/* ---- base64 -> byte array (binary-safe, standard alphabet) ---- */
function b64ToBytes(str) {
  var ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var map = {};
  for (var i = 0; i < ALPHA.length; i++) map[ALPHA.charAt(i)] = i;
  var out = [];
  var s = String(str || "");
  var k = 0;
  while (k < s.length) {
    var b1 = map[s.charAt(k)];
    var b2 = map[s.charAt(k + 1)];
    if (b1 === undefined || b2 === undefined) break;
    var b3 = map[s.charAt(k + 2)];
    var b4 = map[s.charAt(k + 3)];
    out.push((b1 << 2) | (b2 >> 4));
    if (b3 !== undefined) out.push(((b2 & 15) << 4) | (b3 >> 2));
    if (b4 !== undefined) out.push(((b3 & 3) << 6) | b4);
    k += 4;
  }
  return out;
}

function asciiBytes(str) {
  var out = [];
  var s = String(str || "");
  for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 255);
  return out;
}

function bytesToAscii(bytes) {
  var s = "";
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 255);
  return s;
}

function bytesToHex(bytes) {
  var s = "";
  for (var i = 0; i < bytes.length; i++) s += ("0" + (bytes[i] & 255).toString(16)).slice(-2);
  return s;
}

/* ---- AES-256-CBC (pure JS) ---- */
var AES_SBOX = [
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
];
var AES_ISBOX = (function () {
  var inv = new Array(256);
  for (var i = 0; i < 256; i++) inv[AES_SBOX[i]] = i;
  return inv;
})();

function aesXtime(x) {
  return ((x << 1) & 255) ^ (x & 0x80 ? 0x1b : 0);
}
function aesMul(a, b) {
  var r = 0;
  while (b > 0) {
    if (b & 1) r ^= a;
    a = aesXtime(a);
    b >>= 1;
  }
  return r;
}

function aesExpandKey(key) {
  var nk = key.length / 4;
  var nr = nk + 6;
  var w = [];
  for (var i = 0; i < nk; i++) {
    w[i] = ((key[i * 4] & 255) << 24) | ((key[i * 4 + 1] & 255) << 16) |
           ((key[i * 4 + 2] & 255) << 8) | (key[i * 4 + 3] & 255);
  }
  function subWord(x) {
    return ((AES_SBOX[x >>> 24] << 24) | (AES_SBOX[(x >>> 16) & 255] << 16) |
            (AES_SBOX[(x >>> 8) & 255] << 8) | AES_SBOX[x & 255]) >>> 0;
  }
  for (var i = nk; i < 4 * (nr + 1); i++) {
    var t = w[i - 1];
    if (i % nk === 0) {
      t = (((t << 8) | (t >>> 24)) >>> 0);
      t = (subWord(t) ^ (0x01000000 << (((i / nk) | 0) - 1))) >>> 0;
    } else if (nk > 6 && i % nk === 4) {
      t = subWord(t);
    }
    w.push((w[i - nk] ^ t) >>> 0);
  }
  var rk = [];
  for (var r = 0; r <= nr; r++) {
    var bytes = [];
    for (var j = 0; j < 4; j++) {
      var word = w[r * 4 + j];
      bytes.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255);
    }
    rk.push(bytes);
  }
  return rk;
}

function aesInvShiftRows(s) {
  var out = new Array(16);
  for (var c = 0; c < 4; c++) {
    for (var r = 0; r < 4; r++) {
      out[c * 4 + r] = s[((((c - r) % 4) + 4) % 4) * 4 + r];
    }
  }
  return out;
}

function aesInvMixColumns(s) {
  var out = [];
  for (var c = 0; c < 4; c++) {
    var b = s[c * 4], e = s[c * 4 + 1], f = s[c * 4 + 2], g = s[c * 4 + 3];
    out.push(aesMul(b, 14) ^ aesMul(e, 11) ^ aesMul(f, 13) ^ aesMul(g, 9));
    out.push(aesMul(b, 9) ^ aesMul(e, 14) ^ aesMul(f, 11) ^ aesMul(g, 13));
    out.push(aesMul(b, 13) ^ aesMul(e, 9) ^ aesMul(f, 14) ^ aesMul(g, 11));
    out.push(aesMul(b, 11) ^ aesMul(e, 13) ^ aesMul(f, 9) ^ aesMul(g, 14));
  }
  return out;
}

function aesDecryptBlock(ct, rk) {
  var last = rk[rk.length - 1];
  var st = [];
  for (var i = 0; i < 16; i++) st[i] = ct[i] ^ last[i];
  for (var r = rk.length - 2; r > 0; r--) {
    st = aesInvShiftRows(st);
    for (var i = 0; i < 16; i++) st[i] = AES_ISBOX[st[i]];
    for (var i = 0; i < 16; i++) st[i] = st[i] ^ rk[r][i];
    st = aesInvMixColumns(st);
  }
  st = aesInvShiftRows(st);
  for (var i = 0; i < 16; i++) st[i] = AES_ISBOX[st[i]];
  for (var i = 0; i < 16; i++) st[i] = st[i] ^ rk[0][i];
  return st;
}

function aesCbcDecrypt(cipherBytes, keyBytes, ivBytes) {
  var rk = aesExpandKey(keyBytes);
  var out = [];
  var prev = ivBytes.slice();
  var n = cipherBytes.length;
  var i = 0;
  while (i + 16 <= n) {
    var blk = cipherBytes.slice(i, i + 16);
    var dec = aesDecryptBlock(blk, rk);
    for (var j = 0; j < 16; j++) out.push(dec[j] ^ prev[j]);
    prev = blk;
    i += 16;
  }
  var pad = out[out.length - 1];
  if (pad >= 1 && pad <= 16) {
    var ok = true;
    for (var j = 0; j < pad; j++) {
      if (out[out.length - 1 - j] !== pad) { ok = false; break; }
    }
    if (ok) out.length -= pad;
  }
  return out;
}

/* ---- SHA-256 ---- */
var SHA_K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
];

function sha256Bytes(msg) {
  var h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var bitLen = msg.length * 8;
  var padded = msg.slice();
  padded.push(0x80);
  while (padded.length % 64 !== 56) padded.push(0);
  padded.push(0, 0, 0, 0, (bitLen >>> 24) & 255, (bitLen >>> 16) & 255, (bitLen >>> 8) & 255, bitLen & 255);
  var w = new Array(64);
  var i = 0;
  while (i < padded.length) {
    for (var t = 0; t < 16; t++) {
      var o = i + t * 4;
      w[t] = ((padded[o] << 24) | (padded[o + 1] << 16) | (padded[o + 2] << 8) | padded[o + 3]) >>> 0;
    }
    for (var t = 16; t < 64; t++) {
      var s0 = ((w[t - 15] >>> 7) | (w[t - 15] << 25)) ^
               ((w[t - 15] >>> 18) | (w[t - 15] << 14)) ^ (w[t - 15] >>> 3);
      var s1 = ((w[t - 2] >>> 17) | (w[t - 2] << 15)) ^
               ((w[t - 2] >>> 19) | (w[t - 2] << 13)) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (var t = 0; t < 64; t++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var ch = (e & f) ^ (~e & g);
      var t1 = (hh + S1 + ch + SHA_K[t] + w[t]) >>> 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0; h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    i += 64;
  }
  var out = [];
  for (var i = 0; i < 8; i++) {
    out.push((h[i] >>> 24) & 255, (h[i] >>> 16) & 255, (h[i] >>> 8) & 255, h[i] & 255);
  }
  return out;
}

function sha256Hex(text) {
  return bytesToHex(sha256Bytes(asciiBytes(String(text))));
}

function hmacSha256(keyBytes, msgBytes) {
  var k = keyBytes.slice();
  if (k.length > 64) k = sha256Bytes(k);
  while (k.length < 64) k.push(0);
  var opad = [], ipad = [];
  for (var i = 0; i < 64; i++) {
    opad.push(k[i] ^ 0x5c);
    ipad.push(k[i] ^ 0x36);
  }
  return sha256Bytes(opad.concat(sha256Bytes(ipad.concat(msgBytes))));
}

function pbkdf2Sha256(password, salt, iterations, dkLen) {
  var out = [];
  var block = 1;
  while (out.length < dkLen) {
    var start = out.length;
    var u = hmacSha256(password, salt.concat([(block >>> 24) & 255, (block >>> 16) & 255,
      (block >>> 8) & 255, block & 255]));
    var t = u.slice();
    for (var iter = 1; iter < iterations; iter++) {
      u = hmacSha256(password, u);
      for (var i = 0; i < u.length; i++) t[i] = t[i] ^ u[i];
    }
    for (var i = 0; i < t.length; i++) out.push(t[i]);
    block++;
  }
  return out.slice(0, dkLen);
}

/* ---- Tiny WebAssembly binary parser + interpreter ----
 * Only the subset used by flixcloud's ~350 byte kernels: straight-line
 * i32 code with one nested block/loop, load8_u / store8 and a handful of
 * arithmetic ops. Enough to reproduce kn() exactly. */
function readUleb(bytes, pos) {
  var result = 0, shift = 0, b;
  do {
    b = bytes[pos.value];
    pos.value += 1;
    result |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return result >>> 0;
}

function readSleb(bytes, pos) {
  var result = 0, shift = 0, b;
  do {
    b = bytes[pos.value];
    pos.value += 1;
    result |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  if (b & 0x40) result |= -Math.pow(2, shift);
  return result;
}

function parseWasm(bytes) {
  var pos = { value: 8 };
  var exportsList = [];   /* export names in order */
  var bodies = [];        /* function bodies (code section order) */
  while (pos.value < bytes.length) {
    var sectionId = bytes[pos.value]; pos.value += 1;
    var size = readUleb(bytes, pos);
    var end = pos.value + size;
    if (sectionId === 7) {
      var count = readUleb(bytes, pos);
      for (var i = 0; i < count; i++) {
        var nameLen = readUleb(bytes, pos);
        var name = "";
        for (var j = 0; j < nameLen; j++) { name += String.fromCharCode(bytes[pos.value]); pos.value += 1; }
        var kind = bytes[pos.value]; pos.value += 1;
        var idx = readUleb(bytes, pos);
        exportsList.push({ name: name, kind: kind, index: idx });
      }
    } else if (sectionId === 10) {
      var count = readUleb(bytes, pos);
      for (var b = 0; b < count; b++) {
        var bodySize = readUleb(bytes, pos);
        var bodyEnd = pos.value + bodySize;
        var localsCount = readUleb(bytes, pos);
        for (var l = 0; l < localsCount; l++) {
          readUleb(bytes, pos); /* num locals */
          readUleb(bytes, pos); /* val type */
        }
        var ops = [];
        while (pos.value < bodyEnd) {
          var op = bytes[pos.value]; pos.value += 1;
          if (op === 0x20 || op === 0x21 || op === 0x22 || op === 0x23 || op === 0x24) {
            ops.push([op, readUleb(bytes, pos)]);
          } else if (op === 0x41) {
            ops.push([op, readSleb(bytes, pos)]);
          } else if (op >= 0x28 && op <= 0x3e) {
            var align = readUleb(bytes, pos);
            var offs = readUleb(bytes, pos);
            ops.push([op, align, offs]);
          } else if (op === 0x02 || op === 0x03) {
            ops.push([op, readUleb(bytes, pos)]);
          } else if (op === 0x0c || op === 0x0d) {
            ops.push([op, readUleb(bytes, pos)]);
          } else {
            ops.push([op]);
          }
        }
        bodies.push(ops);
      }
    }
    pos.value = end;
  }
  return { exports: exportsList, bodies: bodies };
}

function buildWasmMeta(ops) {
  var meta = {};   /* opIndex -> {type, endPc (for block), inPc (for loop)} */
  var stack = [];
  for (var p = 0; p < ops.length; p++) {
    var c = ops[p][0];
    if (c === 0x02 || c === 0x03) {
      var fr = { type: c === 0x03 ? "loop" : "block", op: p, endPc: -1, inPc: p + 1 };
      meta[p] = fr;
      stack.push(fr);
    } else if (c === 0x0b) {
      var top = stack.pop();
      if (top) top.endPc = p;
    }
  }
  return meta;
}

function execWasmBody(ops, meta, params, memory, globals) {
  var locals = params.slice();
  while (locals.length < 16) locals.push(0);
  var stack = [];
  var active = [];
  var pc = 0;
  var guard = 0;
  while (pc < ops.length && guard < 200000) {
    guard++;
    var op = ops[pc];
    var c = op[0];
    switch (c) {
      case 0x20: stack.push(locals[op[1]]); break;
      case 0x21: locals[op[1]] = stack.pop(); break;
      case 0x22: locals[op[1]] = stack[stack.length - 1]; break;
      case 0x23: stack.push(globals[op[1]]); break;
      case 0x24: globals[op[1]] = (stack.pop() | 0); break;
      case 0x41: stack.push(op[1]); break;
      case 0x2d: stack.push(memory[(stack.pop() + op[2]) >>> 0] & 255); break;
      case 0x2e: stack.push((memory[(stack.pop() + op[2]) >>> 0] << 24) >> 24); break;
      case 0x2f: {
        var adr2 = (stack.pop() + op[2]) >>> 0;
        stack.push((memory[adr2] | (memory[(adr2 + 1) & 0xffffffff] << 8)) & 0xffff);
        break;
      }
      case 0x28: {
        var adr4 = (stack.pop() + op[2]) >>> 0;
        stack.push((memory[adr4] | (memory[(adr4 + 1) & 0xffffffff] << 8) |
                    (memory[(adr4 + 2) & 0xffffffff] << 16) | (memory[(adr4 + 3) & 0xffffffff] << 24)) >>> 0);
        break;
      }
      case 0x3a: {
        var val8 = stack.pop() & 255;
        var adr8 = (stack.pop() + op[2]) >>> 0;
        memory[adr8] = val8;
        break;
      }
      case 0x3d: {
        var val16 = stack.pop();
        var adr16 = (stack.pop() + op[2]) >>> 0;
        memory[adr16] = val16 & 255;
        memory[(adr16 + 1) & 0xffffffff] = (val16 >>> 8) & 255;
        break;
      }
      case 0x36: {
        var val32 = stack.pop() >>> 0;
        var adrW = (stack.pop() + op[2]) >>> 0;
        memory[adrW] = val32 & 255;
        memory[(adrW + 1) & 0xffffffff] = (val32 >>> 8) & 255;
        memory[(adrW + 2) & 0xffffffff] = (val32 >>> 16) & 255;
        memory[(adrW + 3) & 0xffffffff] = (val32 >>> 24) & 255;
        break;
      }
      case 0x45: stack.push(stack.pop() === 0 ? 1 : 0); break;
      case 0x46: { var a=stack.pop(); var b=stack.pop(); stack.push(b === a ? 1 : 0); } break;
      case 0x47: { var a=stack.pop(); var b=stack.pop(); stack.push(b !== a ? 1 : 0); } break;
      case 0x48: { var a=stack.pop(); var b=stack.pop(); stack.push((b | 0) < (a | 0) ? 1 : 0); } break;
      case 0x49: { var a=stack.pop(); var b=stack.pop(); stack.push(b >>> 0 < (a >>> 0) ? 1 : 0); } break;
      case 0x4a: { var a=stack.pop(); var b=stack.pop(); stack.push((b | 0) > (a | 0) ? 1 : 0); } break;
      case 0x4b: { var a=stack.pop(); var b=stack.pop(); stack.push(b >>> 0 > (a >>> 0) ? 1 : 0); } break;
      case 0x4c: { var a=stack.pop(); var b=stack.pop(); stack.push((b | 0) <= (a | 0) ? 1 : 0); } break;
      case 0x4d: { var a=stack.pop(); var b=stack.pop(); stack.push(b >>> 0 <= (a >>> 0) ? 1 : 0); } break;
      case 0x4e: { var a=stack.pop(); var b=stack.pop(); stack.push((b | 0) >= (a | 0) ? 1 : 0); } break;
      case 0x4f: { var a=stack.pop(); var b=stack.pop(); stack.push(b >>> 0 >= (a >>> 0) ? 1 : 0); } break;
      case 0x6a: { var a=stack.pop(); var b=stack.pop(); stack.push((b + a) >>> 0); } break;
      case 0x6b: { var a=stack.pop(); var b=stack.pop(); stack.push((b - a) >>> 0); } break;
      case 0x6c: { var a=stack.pop(); var b=stack.pop(); stack.push(Math.imul(b, a) >>> 0); } break;
      case 0x71: { var a=stack.pop(); var b=stack.pop(); stack.push((b & a) >>> 0); } break;
      case 0x72: { var a=stack.pop(); var b=stack.pop(); stack.push((b | a) >>> 0); } break;
      case 0x73: { var a=stack.pop(); var b=stack.pop(); stack.push((b ^ a) >>> 0); } break;
      case 0x74: { var a=stack.pop(); var b=stack.pop(); stack.push((b << (a & 31)) >>> 0); } break;
      case 0x75: { var a=stack.pop(); var b=stack.pop(); stack.push((b | 0) >> (a & 31)); } break;
      case 0x76: { var a=stack.pop(); var b=stack.pop(); stack.push((b >>> 0) >>> (a & 31)); } break;
      case 0x77: { var a=stack.pop(); var b=stack.pop(); a = a & 31; stack.push((((b << a) | (b >>> (32 - a & 31))) >>> 0)); } break;
      case 0x78: { var a=stack.pop(); var b=stack.pop(); a = a & 31; stack.push((((b >>> a) | (b << (32 - a & 31))) >>> 0)); } break;
      case 0x02: active.push(pc); break;
      case 0x03: active.push(pc); break;
      case 0x0d: {
        var cond = stack.pop();
        if (cond !== 0) {
          var t = active.length - 1 - op[1];
          var f = meta[active[t]];
          if (f.type === "loop") {
            active.length = t + 1;
            pc = f.inPc;
            continue;
          }
          pc = f.endPc + 1;
          active.length = t;
          continue;
        }
        break;
      }
      case 0x0c: {
        var t = active.length - 1 - op[1];
        var f = meta[active[t]];
        if (f.type === "loop") {
          active.length = t + 1;
          pc = f.inPc;
          continue;
        }
        pc = f.endPc + 1;
        active.length = t;
        continue;
      }
      case 0x0b: {
        if (active.length) active.pop();
        break;
      }
      case 0x1a: stack.pop(); break;
      case 0x0f: pc = ops.length; continue;
      default: break; /* unsupported/inert opcodes ignored */
    }
    pc++;
  }
}

/* Reproduce the flixcloud WebAssembly key kernel kn() in pure JS. */
function knKey(frag1, frag2, U, seedInt, wPayloadB64) {
  var wasm = parseWasm(b64ToBytes(wPayloadB64));
  var meta0 = buildWasmMeta(wasm.bodies[0]);
  var meta1 = buildWasmMeta(wasm.bodies[1]);
  var memory = [];
  for (var i = 0; i < 10000; i++) memory.push(0);
  var globals = [];
  var k = frag1.length;
  var I = 1000, P = I + k, Uo = P + k, nt = Uo + k;
  for (var i = 0; i < k; i++) { memory[I + i] = frag1[i]; memory[P + i] = frag2[i]; memory[Uo + i] = U[i]; }
  execWasmBody(wasm.bodies[0], meta0, [seedInt], memory, globals);
  execWasmBody(wasm.bodies[1], meta1, [I, P, Uo, nt, k], memory, globals);
  var out = [];
  for (var i = 0; i < k; i++) out.push(memory[nt + i]);
  return out;
}

/* Derive the obfuscated field names from the seed (matches player xn()). */
function deriveFields(seed) {
  var e = seed;
  for (var o = 0; o < 3; o++) e = sha256Hex(e + String(o));
  var a = e;
  for (var o = 0; o < 3; o++) a = sha256Hex(a + String(o));
  return {
    videoField: "vf_" + e.substring(0, 8),
    keyField: "kf_" + e.substring(8, 16),
    ivField: "ivf_" + e.substring(16, 24),
    containerName: "cd_" + e.substring(24, 32),
    arrayName: "ad_" + e.substring(32, 40),
    objectName: "od_" + e.substring(40, 48),
    tokenField: e.substring(48, 64) + "_" + e.substring(56, 64),
    keyFrag2Field: a.substring(0, 16) + "_" + a.substring(16, 24)
  };
}

/* Decrypt the flixcloud page data (+ token json) into the m3u8 URL. */
function decryptFlix(pageData, tokenJson) {
  var seed = pageData.obfuscation_seed;
  if (!seed || !pageData.obfuscated_crypto_data || !pageData.w_payload) return "";
  var fields = deriveFields(seed);
  var container = pageData.obfuscated_crypto_data[fields.containerName];
  var array = container && container[fields.arrayName];
  var entry = array && array[0] && array[0][fields.objectName];
  if (!entry) return "";
  var frag1 = b64ToBytes(entry[fields.keyField]);
  var iv = b64ToBytes(entry[fields.ivField]);
  var frag2 = b64ToBytes(pageData[fields.keyFrag2Field]);
  var L = pageData[fields.tokenField];
  if (!L || !frag2.length || !frag1.length) return "";
  var vidKey = sha256Hex(L + "vid").substring(0, 10);
  var keyKey = sha256Hex(L + "key").substring(0, 10);
  var P = b64ToBytes(tokenJson[vidKey]);
  var U = b64ToBytes(tokenJson[keyKey]);
  if (!P.length || !U.length) return "";
  var seedInt = parseInt(seed.substring(0, 8), 16);
  var O = knKey(frag1, frag2, U, seedInt, pageData.w_payload);
  var W = pbkdf2Sha256(O, asciiBytes(seed), 1000, 32);
  var tt = [];
  for (var i = 0; i < 32; i++) tt.push(W[i] ^ seed.charCodeAt(i % seed.length));
  var key = sha256Bytes(tt);
  var plain = aesCbcDecrypt(P, key, iv);
  var url = bytesToAscii(plain).replace(/[^\x20-\x7e]/g, "");
  return url;
}

/* Extract the SvelteKit route data object from the embed page HTML. */
function extractRouteData(html) {
  var marker = '{type:"data",data:{';
  var i = String(html).indexOf(marker);
  if (i < 0) {
    marker = '{type:"loaded",data:{';
    i = String(html).indexOf(marker);
  }
  if (i < 0) return null;
  var depth = 0, inStr = false, esc = false;
  var j = i;
  while (j < html.length) {
    var c = html.charAt(j);
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) break; }
    }
    j++;
  }
  var text = html.substring(i, j + 1);
  text = text.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, function (m, pre, key, colon) {
    return pre + '"' + key + '"' + colon;
  });
  var obj = safeParseJson(text);
  return obj && obj.data ? obj.data : null;
}

/* Map a Nuvio id (kitsu:<id>:<n> or plain TMDB) to AniList. */
function mapAnilist(rawId, mediaType) {
  if (!rawId) return Promise.resolve("");
  var kitsuMatch = String(rawId).match(/^kitsu:(\d+)/);
  if (kitsuMatch) {
    var kitsuId = kitsuMatch[1];
    if (LOCAL_ANILIST["kitsu:" + kitsuId]) return Promise.resolve(LOCAL_ANILIST["kitsu:" + kitsuId]);
    return fetchBody("https://kitsu.app/api/edge/anime/" + kitsuId + "/mappings", 700, {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/vnd.api+json"
    }).then(function (r) {
      var parsed = safeParseJson(r.body || "");
      var datas = parsed && parsed.data ? parsed.data : null;
      if (!datas) return "";
      for (var i = 0; i < datas.length; i++) {
        var site = datas[i] && datas[i].attributes ? datas[i].attributes.externalSite : null;
        var ext = datas[i] && datas[i].attributes ? datas[i].attributes.externalId : null;
        if (site === "anilist/anime" && ext !== undefined && ext !== null) return String(ext);
      }
      return "";
    });
  }
  if (LOCAL_ANILIST[mediaType + ":" + rawId]) return Promise.resolve(LOCAL_ANILIST[mediaType + ":" + rawId]);
  var field = mediaType === "movie" ? "themoviedb_movie_id" : "themoviedb_id";
  var url = "https://api.ani.zip/mappings?" + field + "=" + encodeURIComponent(String(rawId));
  return fetchBody(url, 700).then(function (r) {
    var parsed = safeParseJson(r.body || "");
    var m = parsed && parsed.mappings ? parsed.mappings : null;
    return m && m.anilist_id !== undefined && m.anilist_id !== null ? String(m.anilist_id) : "";
  });
}

function pad2(n) {
  var s = String(n);
  return s.length > 1 ? s : "0" + s;
}

/* Resolve one episode to a stream object (or null). */
function resolveEpisode(anilistId, episodeNum, title) {
  if (!anilistId) return Promise.resolve(null);
  var url = ANIMELOK_API + "/" + encodeURIComponent(anilistId) + "/" + encodeURIComponent(episodeNum);
  var ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
  return fetchBody(url, 1200, { "User-Agent": ua, "Referer": "https://animelok.live/" })
    .then(function (r) {
      var api = safeParseJson(r.body || "");
      var servers = api && Array.isArray(api.servers) ? api.servers : null;
      if (!servers || servers.length === 0) return null;
      var chosen = null;
      for (var i = 0; i < servers.length; i++) {
        var s = servers[i];
        if (s && s.serverName === "HD-1" && s.dataType === "sub" && s.dataLink) { chosen = s; break; }
      }
      if (!chosen) {
        for (var i = 0; i < servers.length; i++) {
          var s = servers[i];
          if (s && s.dataType === "sub" && s.dataLink) { chosen = s; break; }
        }
      }
      if (!chosen) return null;
      return chosen.dataLink;
    })
    .then(function (dataLink) {
      if (!dataLink) return null;
      var headers = { "User-Agent": ua, "Referer": FLIX_ORIGIN + "/" };
      return fetchBody(dataLink, 1300, headers).then(function (r2) {
        var pageData = extractRouteData(r2.body || "");
        if (!pageData) return null;
        var L = pageData[deriveFields(pageData.obfuscation_seed || "").tokenField] || "";
        if (!L) return null;
        var origin = "https://flixcloud.cc";
        var dlHost = String(dataLink).match(/^https?:\/\/[^/]+/);
        if (dlHost) origin = dlHost[0];
        return fetchBody(origin + "/api/m3u8/" + encodeURIComponent(L), 1100, {
          "User-Agent": ua,
          "Referer": origin + "/e/" + L
        }).then(function (r3) {
          var tokenJson = safeParseJson(r3.body || "");
          if (!tokenJson) return null;
          var url = decryptFlix(pageData, tokenJson);
          if (!url) return null;
          return {
            name: "Animelok HD-1 Sub",
            title: title,
            url: url,
            quality: "Auto",
            type: "direct",
            headers: { "User-Agent": ua, "Referer": origin + "/" }
          };
        });
      });
    });
}

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var id = String(tmdbId || "").trim();
  var chain = Promise.resolve([]);
  if (id) {
    var isMovie = mediaType === "movie";
    var wantedEpisode = isMovie ? 1 : Number(episodeNum) || 1;
    var title = isMovie ? "Movie " + id : "S01E" + pad2(wantedEpisode);
    chain = mapAnilist(id, mediaType).then(function (anilistId) {
      if (!anilistId) return [];
      return resolveEpisode(anilistId, wantedEpisode, title).then(function (stream) {
        return stream ? [stream] : [];
      });
    }).catch(function () {
      return [];
    });
  }
  return Promise.race([chain, deadline(1500).then(function () { return []; })]);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams, _test: {
    sha256Hex: sha256Hex, aesCbcDecrypt: aesCbcDecrypt, pbkdf2Sha256: pbkdf2Sha256,
    b64ToBytes: b64ToBytes, deriveFields: deriveFields, knKey: knKey,
    decryptFlix: decryptFlix, extractRouteData: extractRouteData,
    parseWasm: parseWasm, execWasmBody: execWasmBody, buildWasmMeta: buildWasmMeta
  } };
} else {
  global.getStreams = getStreams;
}