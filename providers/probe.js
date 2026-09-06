/*
 * Dynamic-path probe for Nuvio. Runs the REAL provider's exact logic:
 *   LOCAL_ANILIST / ani.zip mapping -> animehub -> decrypt -> extract URL
 * but reports the resolved anilist id + real video URL in the STREAM NAME so
 * it is readable in Nuvio. The playable URL is still the mux test stream.
 *
 * What the name tells us:
 *  "DYN anilist=""           -> Nuvio passed bad ids; local map + ani.zip both missed
 *  "DYN anilist=108465 url=… -> dynamic path works; the provider file is the only difference
 *  "DYN fail                 -> dynamic fetch path fails while plain fetch works
 */
var VIDNEST_API = "https://new.vidnest.fun";
var MAPPING_BASE = "https://api.ani.zip/mappings";
var DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
var LOCAL_ANILIST = {
  "tv:94664": "108465",
  "kitsu:42323": "108465",
  "tv:37854": "21",
  "tv:209867": "154587",
  "tv:1429": "16498",
  "tv:85937": "101922",
  "tv:16497": "101922"
};
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

function mapAnilist(rawId, mediaType) {
  if (!rawId) return Promise.resolve("");
  var kitsuMatch = String(rawId).match(/^kitsu:(\d+)/);
  if (kitsuMatch) {
    var kitsuId = kitsuMatch[1];
    var local = LOCAL_ANILIST["kitsu:" + kitsuId];
    if (local) return Promise.resolve(local);
    return fetchBody("https://kitsu.app/api/edge/anime/" + kitsuId + "/mappings", 900, {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/vnd.api+json"
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

function fetchSourceBundle(anilistId, episodeNum, audioType, endpoint) {
  if (!anilistId) return Promise.resolve(null);
  var type = audioType || "sub";
  var url =
    VIDNEST_API + "/" + endpoint + "/" +
    encodeURIComponent(anilistId) + "/" +
    encodeURIComponent(episodeNum) + "/" +
    encodeURIComponent(type);
  var headers = { "User-Agent": DEFAULT_UA, "Referer": "https://play.echovideo.ru/" };
  return fetchBody(url, 1500, headers).then(function (r) {
    if (!r.body) return null;
    var raw = safeParseJson(r.body);
    if (!raw || typeof raw !== "object") return null;
    return raw.encrypted && typeof raw.data === "string" ? safeParseJson(vnDecode(raw.data)) : raw;
  }).catch(function () { return null; });
}

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var id = String(tmdbId || "").trim();
  var isMovie = mediaType === "movie";
  var wantedEpisode = isMovie ? 1 : Number(episodeNum) || 1;
  var tag = "tmdb=" + id + " mv=" + String(isMovie) + " ep=" + wantedEpisode;

  return mapAnilist(id, mediaType).then(function (anilistId) {
    if (!anilistId) return [mk("DYN " + tag + " anilist=EMPTY", "")];
    return fetchSourceBundle(anilistId, wantedEpisode, "sub", "animehub").then(function (b) {
      if (b && Array.isArray(b.sources) && b.sources.length > 0) {
        return [mk("DYN " + tag + " anilist=" + anilistId + " url=" + String(b.sources[0].url).slice(0, 24), b.sources[0].url)];
      }
      return [mk("DYN " + tag + " anilist=" + anilistId + " noSources", "")];
    });
  }).catch(function (e) {
    return [mk("DYN " + tag + " fail " + (e && e.message ? e.message : String(e)), "")];
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