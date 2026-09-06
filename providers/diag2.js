/*
 * Network diagnostic for Nuvio - makes the SAME two fetches the real
 * provider makes and reports the outcome in the stream name, so the user
 * can read the result right in Nuvio without logs.
 *
 *  stream 1: fetch https://api.ani.zip/mappings?themoviedb_id=94664
 *  stream 2: fetch https://new.vidnest.fun/animehub/108465/1/sub
 *
 * If names show "OK" -> that call works inside Nuvio's sandbox.
 * If names show "FAIL"/"HANG" -> that call is blocked/broken in Nuvio.
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

function safeStatus(p, ms) {
  return new Promise(function (resolve) {
    var settled = false;
    var holder = { status: "HANG", body: "" };
    function out() {
      if (settled) return;
      settled = true;
      resolve(holder.status + " " + holder.body);
    }
    deadline(ms).then(function () { holder.status = "HANG"; out(); });
    p.then(function (r) { holder.status = "OK"; return r.text(); })
      .then(function (t) { holder.body = String(t || "").slice(0, 24); out(); })
      .catch(function (e) {
        holder.status = "FAIL" + (e && e.message ? ":" + e.message : "");
        out();
      });
  });
}

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  return Promise.all([
    safeStatus(mappingFetch(), 1200),
    safeStatus(sourceFetch(), 1200)
  ]).then(function (statuses) {
    return [
      {
        name: "Net-Mapping " + statuses[0],
        title: "api.ani.zip (Mushoku map)",
        url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
        quality: "Auto",
        type: "direct",
        headers: { "User-Agent": "Mozilla/5.0" }
      },
      {
        name: "Net-Source " + statuses[1],
        title: "new.vidnest.fun (animehub sub)",
        url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
        quality: "Auto",
        type: "direct",
        headers: { "User-Agent": "Mozilla/5.0" }
      }
    ];
  });
}

function getProbe(opts, url) {
  if (typeof fetch !== "function") return Promise.reject(new Error("NO-FETCH"));
  var req = { method: "GET", headers: { "User-Agent": "Mozilla/5.0" } };
  if (opts.headers) { req.headers = opts.headers; }
  return fetch(url, req);
}

function mappingFetch() {
  return getProbe({}, "https://api.ani.zip/mappings?themoviedb_id=94664");
}

function sourceFetch() {
  return getProbe(
    { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://megaplay.buzz/" } },
    "https://new.vidnest.fun/animehub/108465/1/sub"
  );
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}