/*
 * AnimeDex (Anivexa) provider for Nuvio.
 *
 * Hard-subbed anime HLS from the anivexa backend of animedex.fun, the
 * AnimePahe-style scraping server that powers the site's player. Turns a
 * matched anilist id + episode number into direct, plaintext m3u8 masters
 * served by its CDN workers (no scrambling) so the native Nuvio player can
 * play them as-is. Runtime-style mirrors the proven vidnest provider.
 */
var ANIMEDEX_API = "https://animedex.fun/api/stream/anivexa";
var MAPPING_BASE = "https://api.ani.zip/mappings";
var DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/* Pre-seeded TMDB->AniList ids so popular titles skip the slow ani.zip
 * round-trip. Keyed as "<mediaType>:<tmdbId>". */
var LOCAL_ANILIST = {
  "tv:94664": "108465",    /* Mushoku Tensei (TMDB) */
  "kitsu:42323": "108465", /* Mushoku Tensei (Kitsu S1) */
  "tv:37854": "21",        /* One Piece */
  "tv:209867": "154587",   /* Frieren */
  "tv:1429": "16498",      /* Attack on Titan */
  "tv:85937": "101922",    /* Demon Slayer */
  "tv:16497": "101922"     /* Demon Slayer (alt seed) */
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

/* Fetch with a hard deadline. Always resolves to {status, body}. */
function fetchBody(url, ms, options) {
  return new Promise(function (resolve) {
    var done = false;
    function out(s, b) { if (!done) { done = true; resolve({ status: s, body: b }); } }
    deadline(ms).then(function () { out(0, ""); });
    if (typeof fetch !== "function") { out(-1, ""); return; }
    var init = { method: "GET", headers: { "User-Agent": "Mozilla/5.0" } };
    if (options) {
      if (options.method) init.method = options.method;
      if (options.headers) init.headers = options.headers;
      if (options.body !== undefined) init.body = options.body;
    }
    fetch(url, init)
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

/* Map media id (kitsu or TMDB) -> AniList with the same strategy as the
 * vidnest provider, since animedex keys its streams by anilist id. */
function mapAnilist(rawId, mediaType) {
  if (!rawId) return Promise.resolve("");

  var kitsuMatch = String(rawId).match(/^kitsu:(\d+)/);
  if (kitsuMatch) {
    var kitsuId = kitsuMatch[1];
    var local = LOCAL_ANILIST["kitsu:" + kitsuId];
    if (local) return Promise.resolve(local);
    return fetchBody("https://kitsu.app/api/edge/anime/" + kitsuId + "/mappings", 900, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/vnd.api+json" }
    }).then(function (r) {
      var parsed = safeParseJson(r.body || "");
      var datas = parsed && parsed.data ? parsed.data : null;
      if (!datas) return "";
      for (var i = 0; i < datas.length; i++) {
        var site = datas[i] && datas[i].attributes ? datas[i].attributes.externalSite : null;
        var ext = datas[i] && datas[i].attributes ? datas[i].attributes.externalId : null;
        if (site === "anilist/anime" && ext !== undefined && ext !== null) {
          return String(ext);
        }
      }
      return "";
    });
  }

  var local = LOCAL_ANILIST[mediaType + ":" + rawId];
  if (local) return Promise.resolve(local);

  var field = mediaType === "movie" ? "themoviedb_movie_id" : "themoviedb_id";
  var url = MAPPING_BASE + "?" + field + "=" + encodeURIComponent(String(rawId));
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

/* Ask the animedex anivexa backend for the episode's masters. Resolves to
 * the raw {sources:[...]} object or null. Retries once on empty/fail. */
function fetchAnivexa(anilistId, episodeNum, lang) {
  if (!anilistId) return Promise.resolve(null);
  var payload = JSON.stringify({
    anilistId: Number(anilistId) || anilistId,
    ep: String(episodeNum),
    lang: lang || "sub",
    provider: "anineko"
  });
  var headers = {
    "User-Agent": DEFAULT_UA,
    "Referer": "https://animedex.fun/",
    "Content-Type": "application/json"
  };

  var attempt = function () {
    return fetchBody(ANIMEDEX_API, 5000, { method: "POST", headers: headers, body: payload })
      .then(function (r) {
        var parsed = safeParseJson(r.body || "");
        if (!parsed || typeof parsed !== "object" || parsed.error) return null;
        if (Array.isArray(parsed.sources) && parsed.sources.length > 0) return parsed;
        return null;
      })
      .catch(function () { return null; });
  };

  return attempt().then(function (bundle) {
    if (bundle) return bundle;
    return attempt();
  });
}

function buildStream(url, quality, title) {
  var q = detectQuality(quality || url);
  var qualityLabel = q > 0 ? String(q) + "p" : "Auto";
  return {
    name: "AnimeDex Clean " + qualityLabel,
    title: title,
    url: url,
    quality: qualityLabel,
    type: "direct",
    headers: { "User-Agent": DEFAULT_UA, "Referer": "https://animedex.fun/" }
  };
}

function collectStreams(bundle, title) {
  var out = [];
  if (bundle && Array.isArray(bundle.sources)) {
    for (var i = 0; i < bundle.sources.length; i++) {
      var item = bundle.sources[i];
      if (!item || typeof item !== "object") continue;
      var sUrl = item.url || item.file || "";
      if (!sUrl || sUrl.indexOf("m3u8") === -1) continue;
      out.push(buildStream(sUrl, item.quality, title));
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

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var id = String(tmdbId || "").trim();
  if (!id) return Promise.resolve([]);

  var isMovie = mediaType === "movie";
  var wantedEpisode = isMovie ? 1 : Number(episodeNum) || 1;
  var title = isMovie ? "Movie " + id : "S01E" + pad2(wantedEpisode);

  return mapAnilist(id, mediaType).then(function (anilistId) {
    if (!anilistId) return [];
    return fetchAnivexa(anilistId, wantedEpisode, "sub").then(function (bundle) {
      var list = collectStreams(bundle, title);
      if (list.length > 0) return list;
      return fetchAnivexa(anilistId, wantedEpisode, "dub").then(function (bundle2) {
        return collectStreams(bundle2, title);
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