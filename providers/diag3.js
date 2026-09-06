/*
 * Full-pipeline diagnostic for Nuvio: runs the exact same process as the real
 * provider (map tmdb -> anilist, then fetch+decrypt animehub sub) but in
 * serial with per-stage millisecond timing, and reports the result in the
 * stream NAMES so it is readable straight in Nuvio.
 *
 * Expected healthy result for Mushoku S1E1 if Nuvio has a ~2s budget:
 *   name: "Pipe 94664 -> 108465 src=1000/sub#x okTime=NNNms ..." etc.
 * Troubleshooting by what you see:
 *   "mapfail" / "noanilist"  -> the ani.zip call inside Nuvio mis-parses
 *   "srcempty"               -> the animehub source came back empty in Nuvio
 *   "ok 3urls..."            -> whole chain works but is slow => budget issue
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

function fetchWithDeadline(url, ms, headers) {
  if (typeof fetch !== "function") return Promise.resolve({ status: -1, text: function () { return Promise.resolve(""); } });
  var done = false;
  var holder = { status: 0, body: "" };
  function wrap(res) {
    holder.status = res && typeof res.status === "number" ? res.status : 0;
    if (res && typeof res.text === "function") {
      return res.text().then(function (t) { holder.body = String(t || ""); });
    }
    holder.body = String(res || "");
    return Promise.resolve();
  }
  return new Promise(function (resolve) {
    function out(s, b) { if (done) return; done = true; resolve({ status: s, body: b, text: function () { return Promise.resolve(b); } }); }
    (function () {
      return fetch(url, { method: "GET", headers: headers || { "User-Agent": "Mozilla/5.0" } })
        .then(wrap)
        .then(function () { out(holder.status, holder.body); })
        .catch(function () { out(-2, ""); });
    })();
    deadline(ms).then(function () { out(0, ""); });
  });
}

var VN_ALPHABET = "RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/=";
function vnDecode(str) {
  var m = {};
  for (var i = 0; i < VN_ALPHABET.length; i++) m[VN_ALPHABET.charAt(i)] = i;
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

function safeParse(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var id = String(tmdbId || "").trim();
  var start = Date.now();
  var field = mediaType === "movie" ? "themoviedb_movie_id" : "themoviedb_id";
  var mapUrl = "https://api.ani.zip/mappings?" + field + "=" + encodeURIComponent(id);

  return fetchWithDeadline(mapUrl, 800)
    .then(function (mres) {
      var tMap = Date.now() - start;
      var text = mres.body || "";
      var mapped = safeParse(text);
      var anilist = "";
      if (mapped && mapped.mappings && mapped.mappings.anilist_id !== undefined && mapped.mappings.anilist_id !== null) {
        anilist = String(mapped.mappings.anilist_id);
      }
      if (!anilist) {
        return [{
          name: "Pipe mapfail t=" + tMap + "ms st=" + mres.status,
          title: "no anilist for id=" + id + " body=" + text.slice(0, 40),
          url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
          quality: "Auto", type: "direct", headers: { "User-Agent": "Mozilla/5.0" }
        }];
      }
      var srcStart = Date.now();
      var srcUrl = "https://new.vidnest.fun/animehub/" + encodeURIComponent(anilist) + "/1/sub";
      return fetchWithDeadline(srcUrl, 800, { "User-Agent": "Mozilla/5.0", "Referer": "https://play2.echovideo.ru/" })
        .then(function (sres) {
          var tSrc = Date.now() - srcStart;
          var sText = sres.body || "";
          var parsed = safeParse(sText);
          var resolved = null;
          var raw = parsed || {};
          if (raw.encrypted && typeof raw.data === "string") {
            resolved = safeParse(vnDecode(raw.data));
          } else if (parsed) {
            resolved = parsed;
          }
          var n = resolved && Array.isArray(resolved.sources) ? resolved.sources.length : -1;
          var name = "Pipe ok anilist=" + anilist + " map" + tMap + "ms src" + tSrc + "ms";
          if (n < 0) name = "Pipe srcempty anilist=" + anilist + " st=" + sres.status + " hit-enc=" + (raw.encrypted === true) + " body=" + sText.slice(0, 20);
          else name = "Pipe ok anilist=" + anilist + " #src=" + n + " map" + tMap + "ms src" + tSrc + "ms";
          return [{
            name: name,
            title: "url=" + srcUrl,
            url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
            quality: "Auto", type: "direct", headers: { "User-Agent": "Mozilla/5.0" }
          }];
        });
    });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}