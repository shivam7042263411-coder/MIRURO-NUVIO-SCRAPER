/*
 * Status probe for Nuvio - reports the real HTTP status codes your device
 * gets from the two servers the provider depends on. The value appears in
 * the stream name, readable right in Nuvio.
 *
 *   "S-VidNest-200 OK 200"   -> server answered OK; provider logic is right
 *   "S-VidNest-502 ..."      -> server rejected YOUR device/network (502)
 *   "S-VidNest-000 HANG"     -> request never answered (network blocked)
 *   "M-ani.zip-404 ..."      -> mapping server rejected your network (404)
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

function probe(url, label, headers) {
  return new Promise(function (resolve) {
    var done = false;
    function out(name) { if (!done) { done = true; resolve(name); } }
    deadline(1400).then(function () { out(label + "-000 HANG"); });
    if (typeof fetch === "function") {
      fetch(url, { method: "GET", headers: headers || { "User-Agent": "Mozilla/5.0" } })
        .then(function (r) {
          out(label + "-" + String(r && r.status) + " " + (r && r.ok ? "OK" : "ERR"));
        })
        .catch(function (e) {
          out(label + "-EXC " + (e && e.message ? e.message : "err"));
        });
    } else {
      out(label + "-NOfetch");
    }
  });
}

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var a = probe(
    "https://new.vidnest.fun/animehub/108465/1/sub",
    "SA",
    { "User-Agent": "Mozilla/5.0", "Referer": "https://play2.echovideo.ru/" }
  );
  var b = probe(
    "https://new.vidnest.fun/aniwave_hls/108465/1/sub",
    "SB",
    { "User-Agent": "Mozilla/5.0", "Referer": "https://play.echovideo.ru/" }
  );
  var c = probe(
    "https://api.ani.zip/mappings?themoviedb_id=94664",
    "M"
  );
  return Promise.all([a, b, c]).then(function (names) {
    return names.map(function (name) {
      return {
        name: name,
        title: "probe - not real content",
        url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
        quality: "Auto",
        type: "direct",
        headers: { "User-Agent": "Mozilla/5.0" }
      };
    });
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}