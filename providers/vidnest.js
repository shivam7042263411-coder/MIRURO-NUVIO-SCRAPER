/*
 * Animeya (VidNest) provider for Nuvio.
 *
 * Hard-subbed (AnimePahe-style burned-in subtitle) anime HLS from VidNest,
 * the same backend that powers animeya.cc. Uses the identical runtime style
 * as the proven-working probe: simple deadline() + fetchBody(), plain {}
 * objects, no exotic globals. Kept deliberately small so it runs anywhere.
 */
var VIDNEST_API = "https://new.vidnest.fun";
var MAPPING_BASE = "https://api.ani.zip/mappings";
var DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/* Pre-seeded TMDB->AniList ids so popular titles skip the slow ani.zip
 * round-trip. Keyed as "<mediaType>:<tmdbId>". */
var LOCAL_ANILIST = {
  "tv:94664": "108465",    /* Mushoku Tensei */
  "tv:37854": "21",        /* One Piece */
  "tv:209867": "154587",   /* Frieren */
  "tv:1429": "16498",      /* Attack on Titan */
  "tv:85937": "101922",    /* Demon Slayer */
  "tv:16497": "101922"     /* Demon Slayer (alt seed) */
};

/* VidNest custom base64 alphabet. */
var VN_ALPHABET = "RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/=";

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

/* Decode a VidNest custom-base64 payload to a binary string. */
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

/* Fetch text with a hard deadline. Always resolves to {status, body}.
 * Never rejects. */
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

/* Parse and decrypt a VidNest response body into a bundle object, or null. */
function parseBundle(body) {
  var raw = safeParseJson(String(body || ""));
  if (!raw || typeof raw !== "object") return null;
  if (raw.encrypted && typeof raw.data === "string") {
    return safeParseJson(vnDecode(raw.data));
  }
  return raw;
}

/* Map TMDB -> AniList. Local table first, ani.zip fallback. Returns a
 * promise resolving to the anilist id (string) or "". */
function mapAnilist(tmdbId, mediaType) {
  if (!tmdbId) return Promise.resolve("");
  var local = LOCAL_ANILIST[mediaType + ":" + tmdbId];
  if (local) return Promise.resolve(local);

  var field = mediaType === "movie" ? "themoviedb_movie_id" : "themoviedb_id";
  var url = MAPPING_BASE + "?" + field + "=" + encodeURIComponent(String(tmdbId));
  return fetchBody(url, 900).then(function (r) {
    var parsed = safeParseJson(r.body || "");
    var m = parsed && parsed.mappings ? parsed.mappings : null;
    return m && m.anilist_id !== undefined && m.anilist_id !== null ? String(m.anilist_id) : "";
  });
}

function detectQuality(value) {
  if (value === undefined || value === null) return 0;
  var str = String(value);
  var match = str.match(/(2160|1440|1080|720|480|360)/);
  return match ? parseInt(match[1], 10) : 0;
}

function pad2(n) {
  var s = String(n);
  return s.length > 1 ? s : "0" + s;
}

function buildStream(streamUrl, item, audioType, title) {
  var headers = { "User-Agent": DEFAULT_UA };
  if (item.referer) headers["Referer"] = item.referer;
  var quality = detectQuality(item.quality || streamUrl);
  var qualityLabel = quality > 0 ? String(quality) + "p" : "Auto";
  return {
    name: "Animeya " + audioType.toUpperCase() + " " + qualityLabel,
    title: title,
    url: streamUrl,
    quality: qualityLabel,
    type: "direct",
    headers: headers
  };
}

function collectStreams(bundle, audioType, title) {
  var out = [];
  if (bundle && Array.isArray(bundle.sources)) {
    for (var i = 0; i < bundle.sources.length; i++) {
      var item = bundle.sources[i];
      if (!item || typeof item !== "object") continue;
      var sUrl = item.url || item.file || "";
      if (!sUrl) continue;
      out.push(buildStream(sUrl, item, audioType, title));
    }
  }
  return out;
}

function dedupe(streams) {
  var seen = {};
  var out = [];
  for (var i = 0; i < streams.length; i++) {
    var key = streams[i].url + "|" + streams[i].quality;
    if (seen[key]) continue;
    seen[key] = true;
    out.push(streams[i]);
  }
  return out;
}

/* Fetch one source endpoint for an episode. Retries once on a 502/empty
 * (fast-fail) to ride out intermittent server errors. */
function fetchSourceBundle(anilistId, episodeNum, audioType, endpoint) {
  if (!anilistId) return Promise.resolve(null);
  var type = audioType || "sub";
  var url =
    VIDNEST_API + "/" + endpoint + "/" +
    encodeURIComponent(anilistId) + "/" +
    encodeURIComponent(episodeNum) + "/" +
    encodeURIComponent(type);
  var headers = {
    "User-Agent": DEFAULT_UA,
    "Referer": "https://play.echovideo.ru/"
  };

  var attempt = function (headers) {
    return fetchBody(url, 1500, headers).then(function (r) {
      if (!r.body) return null;
      return parseBundle(r.body);
    }).catch(function () { return null; });
  };

  return attempt(headers).then(function (bundle) {
    if (bundle && Array.isArray(bundle.sources) && bundle.sources.length > 0) return bundle;
    return attempt(headers);
  });
}

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var id = String(tmdbId || "").trim();
  if (!id) return Promise.resolve([]);

  var isMovie = mediaType === "movie";
  var wantedEpisode = isMovie ? 1 : Number(episodeNum) || 1;
  var title = isMovie ? "Movie " + id : "S01E" + pad2(wantedEpisode);

  return mapAnilist(id, mediaType).then(function (anilistId) {
    if (!anilistId) return [];
    /* animehub (hard-sub) first; aniwave as fallback, same hard-sub. */
    return fetchSourceBundle(anilistId, wantedEpisode, "sub", "animehub").then(function (b) {
      var list = collectStreams(b, "sub", title);
      if (list.length > 0) return list;
      return fetchSourceBundle(anilistId, wantedEpisode, "sub", "aniwave_hls").then(function (b2) {
        return collectStreams(b2, "sub", title);
      });
    });
  }).then(function (finalList) {
    return dedupe(finalList);
  }).catch(function () {
    return [];
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}