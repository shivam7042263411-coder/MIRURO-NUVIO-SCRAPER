/*
 * Full-pipeline probe for Nuvio. Does the EXACT same work as the real
 * provider and reports the result right in the stream name:
 *   status + whether the body decrypts + how many playable sources came out.
 *
 * "P-SRC src=200 dec=OK n=1 t=400ms"  -> pipeline works; real provider should work
 * "P-SRC src=200 dec=FAIL"            -> body doesn't decrypt in Nuvio (Hermes bug)
 * "P-SRC src=200 n=0"                 -> servers returned nothing for this ep
 */
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

/* VidNest custom base64 (same alphabet as the real provider). */
var VN_ALPHABET_V = "RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/=";
function vnDecodeV(str) {
  var m = {};
  for (var i = 0; i < VN_ALPHABET_V.length; i++) m[VN_ALPHABET_V.charAt(i)] = i;
  var out = [];
  var k = 0;
  while (k < str.length) {
    var b1 = m[str.charAt(k)] === undefined ? 64 : m[str.charAt(k)];
    var b2 = m[str.charAt(k + 1)] === undefined ? 64 : m[str.charAt(k + 1)];
    var b3 = m[str.charAt(k + 2)] === undefined ? 64 : m[str.charAt(k + 2)];
    var b4 = m[str.charAt(k + 3)] === undefined ? 64 : m[str.charAt(k + 3)];
    out.push((b1 << 2) | (b2 >> 4));
    if (b3 !== 64) out.push(((b2 & 15) << 4) | (b3 >> 2));
    if (b4 !== 64) out.push(((b3 & 3) << 6) | b4);
    k += 4;
  }
  var bin = "";
  for (var j = 0; j < out.length; j++) bin += String.fromCharCode(out[j]);
  return bin;
}

function safeParseV(text) {
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

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var t0 = Date.now();
  return fetchBody("https://new.vidnest.fun/animehub/108465/1/sub", 2000, {
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://play2.echovideo.ru/"
  }).then(function (r) {
    var head = "P-SRC src=" + r.status + " t=" + (Date.now() - t0) + "ms";
    var text = r.body || "";
    var raw = safeParseV(text);
    if (!raw || typeof raw !== "object") return [mk(head + " body=NOTJSON", text.slice(0, 40))];
    if (raw.encrypted && typeof raw.data === "string") {
      var dec;
      try { dec = vnDecodeV(raw.data); } catch (e) { dec = ""; }
      var parsed = safeParseV(dec);
      if (!parsed || typeof parsed !== "object") return [mk(head + " dec=FAIL", dec.slice(0, 40))];
      var n = Array.isArray(parsed.sources) ? parsed.sources.length : -1;
      var u = n > 0 && parsed.sources[0].url ? parsed.sources[0].url : "";
      return [mk(head + " dec=OK n=" + n, u.slice(0, 36))];
    }
    if (Array.isArray(raw.sources)) return [mk(head + " plain n=" + raw.sources.length, text.slice(0, 40))];
    return [mk(head + " nodecrypt ", text.slice(0, 40))];
  });
}

function mk(name, title) {
  return {
    name: name,
    title: title || "probe",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    quality: "Auto",
    type: "direct",
    headers: { "User-Agent": "Mozilla/5.0" }
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}