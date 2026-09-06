/*
 * VidNest (Animeya) Anime provider for Nuvio
 *
 * Scrapes hard-subbed (AnimePahe-style burned-in subtitle) anime sources from
 * VidNest - the same backend that powers animeya.cc - and returns playable HLS
 * streams for Nuvio playback. The provider:
 *
 *   1. Maps the incoming TMDB id to an AniList id via ani.zip (no slug step
 *      needed - VidNest keys straight off the AniList id).
 *   2. Requests "animehub" sources (hard-subbed encodes, AnimePahe-style)
 *      which arrive custom-base64 encrypted.
 *   3. Decrypts, then returns the .m3u8 stream plus the CDN referer header
 *      the host requires.
 *
 * The api response selects between the same URL you ask for: e.g.
 *   https://new.vidnest.fun/animehub/{anilistId}/{episode}/{sub|dub}
 * returns a hard-subbed stream (no separate sub track - burned in), while
 * "aniwave_hls" returns a second hard-subbed host.
 *
 * Robustness notes: everything is promise-safe (no path rejects - each
 * sub-call resolves to [] instead), there are no in-sandbox CDN probes, and
 * every fetch has a hard timeout. Written against ES5-safe constructs so it
 * runs even in older QuickJS builds.
 */
var VIDNEST_API = "https://new.vidnest.fun";
var MAPPING_BASE = "https://api.ani.zip/mappings";
var DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/* Pre-seeded TMDB->AniList ids so popular titles skip the (slow) ani.zip
 * round-trip entirely. Keyed as "<mediaType>:<tmdbId>". */
var LOCAL_ANILIST = {
  "tv:94664": "108465",    /* Mushoku Tensei */
  "tv:37854": "21",        /* One Piece */
  "tv:209867": "154587",   /* Frieren */
  "tv:1429": "16498",      /* Attack on Titan */
  "tv:85937": "101922",    /* Demon Slayer */
  "tv:16497": "101922"     /* Demon Slayer (alt seed) */
};

/* Custom base64 alphabet used by VidNest to obfuscate its JSON responses. */
var VN_ALPHABET = "RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/=";
var VN_INDEX = null;

var caches = {
  mapping: Object.create(null),
  decrypt: Object.create(null)
};

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function vnIndex() {
  if (VN_INDEX) return VN_INDEX;
  var m = {};
  for (var i = 0; i < VN_ALPHABET.length; i++) {
    m[VN_ALPHABET.charAt(i)] = i;
  }
  VN_INDEX = m;
  return m;
}

/* Decode a VidNest custom-base64 string into a binary (byte-per-char) string.
 * Works on the JSON payload, which is UTF-8/ASCII, so String.fromCharCode is
 * accurate for every byte. */
function vnDecode(str) {
  var idx = vnIndex();
  var out = [];
  var i = 0;
  while (i < str.length) {
    var b1 = idx[str.charAt(i)] === undefined ? 64 : idx[str.charAt(i)];
    var b2 = idx[str.charAt(i + 1)] === undefined ? 64 : idx[str.charAt(i + 1)];
    var b3 = idx[str.charAt(i + 2)] === undefined ? 64 : idx[str.charAt(i + 2)];
    var b4 = idx[str.charAt(i + 3)] === undefined ? 64 : idx[str.charAt(i + 3)];
    out.push((b1 << 2) | (b2 >> 4));
    if (b3 !== 64) out.push(((b2 & 15) << 4) | (b3 >> 2));
    if (b4 !== 64) out.push(((b3 & 3) << 6) | b4);
    i += 4;
  }
  var bin = "";
  for (var j = 0; j < out.length; j++) bin += String.fromCharCode(out[j]);
  return bin;
}

/* Nuvio's QuickJS sandbox may not expose setTimeout/clearTimeout (the app
 * enforces its own global timeout instead) or fetch. Detect them so we never
 * throw when absent - resolve [] / "" cleanly instead. */
var HAS_TIMEOUT = typeof setTimeout === "function" && typeof clearTimeout === "function";
var HAS_FETCH = typeof fetch === "function";
var HAS_CONSOLE = typeof console === "object" && console !== null && typeof console.log === "function";

/* Nuvio waits roughly 2s for a provider. The single source fetch can take
 * VidNest up to ~2.5s on a warm CDN, so we cap just under the budget and
 * resolve with whatever the fastest positive host returns. No mapping
 * round-trip for seeded titles (see LOCAL_ANILIST), so total = 1 fetch. */
var FETCH_TIMEOUT_MS = 1900;

function logStep(msg) {
  if (!HAS_CONSOLE) return;
  try {
    console.log("[vidnest] " + msg);
  } catch (e) {}
}

/* fetch helper with a best-effort timeout. Always resolves with a string (or
 * an empty string on any failure) so callers never handle rejections. */
function fetchText(url) {
  var timer = null;
  var timedOut = false;

  var cleanup = function () {
    if (timer !== null && HAS_TIMEOUT) clearTimeout(timer);
  };

  return new Promise(function (resolve) {
    if (HAS_TIMEOUT) {
      timer = setTimeout(function () {
        timedOut = true;
        resolve("");
      }, FETCH_TIMEOUT_MS);
    }

    var finish = function (text) {
      if (timedOut) return;
      cleanup();
      resolve(typeof text === "string" ? text : "");
    };

    if (!HAS_FETCH) {
      cleanup();
      resolve("");
      return;
    }

    var headers = {
      Accept: "*/*",
      "User-Agent": DEFAULT_UA
    };

    fetch(url, {
      method: "GET",
      headers: headers
    })
      .then(function (res) {
        if (res && typeof res.text === "function") {
          return res.text();
        }
        return String(res);
      })
      .then(finish)
      .catch(function () {
        if (timedOut) return;
        cleanup();
        resolve("");
      });
  });
}

function getJson(url) {
  return fetchText(url).then(function (text) {
    if (!text) return null;
    return safeParseJson(text);
  });
}

function getJsonCached(url, cacheKey, cacheStore) {
  if (cacheStore && cacheKey !== undefined && cacheStore[cacheKey]) {
    return Promise.resolve(cacheStore[cacheKey]);
  }
  return getJson(url).then(function (parsed) {
    if (parsed && cacheStore) cacheStore[cacheKey] = parsed;
    return parsed;
  });
}

/* Map a TMDB id (movie or tv) to an AniList id. Local table first (no
 * network), ani.zip fallback for anything unknown. Never rejects; resolves
 * with "" when unmapped. */
function mapAnilistFromTmdb(tmdbId, mediaType) {
  if (!tmdbId) return Promise.resolve("");

  var localKey = mediaType + ":" + tmdbId;
  if (LOCAL_ANILIST[localKey]) return Promise.resolve(LOCAL_ANILIST[localKey]);

  var field = mediaType === "movie" ? "themoviedb_movie_id" : "themoviedb_id";
  var url = MAPPING_BASE + "?" + field + "=" + encodeURIComponent(String(tmdbId));

  return getJsonCached(url, String(tmdbId) + ":" + mediaType, caches.mapping).then(function (parsed) {
    if (!parsed || typeof parsed !== "object") return "";
    var mappings = parsed.mappings || {};
    var mapped = mappings.anilist_id;
    return mapped !== undefined && mapped !== null ? String(mapped) : "";
  });
}

/* Fetch one VidNest source bundle for an episode and decrypt it. Returns the
 * parsed JSON (sources: [{url, quality, type, server, referer}], multiSrc,
 * intro, outro) or null when nothing is found. Never rejects. */
function fetchSources(anilistId, episodeNum, audioType, endpoint) {
  if (!anilistId) return Promise.resolve(null);
  var type = audioType || "sub";
  var key = anilistId + "|" + episodeNum + "|" + type + "|" + endpoint;
  if (caches.decrypt[key]) return Promise.resolve(caches.decrypt[key]);

  var url =
    VIDNEST_API +
    "/" +
    endpoint +
    "/" +
    encodeURIComponent(anilistId) +
    "/" +
    encodeURIComponent(episodeNum) +
    "/" +
    encodeURIComponent(type);

  var parseResponse = function (raw) {
    var parsed = null;
    if (raw && typeof raw === "object" && raw.encrypted && typeof raw.data === "string") {
      parsed = safeParseJson(vnDecode(raw.data));
    } else if (raw && typeof raw === "object") {
      parsed = raw;
    }
    if (!parsed || typeof parsed !== "object" || parsed.success === false) return null;
    if (!Array.isArray(parsed.sources) || parsed.sources.length === 0) return null;
    caches.decrypt[key] = parsed;
    return parsed;
  };

  return getJson(url)
    .then(parseResponse)
    .catch(function () {
      return null;
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

function dedupe(streams) {
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < streams.length; i++) {
    var key = String(streams[i].url || "") + "|" + String(streams[i].quality || "");
    if (seen[key]) continue;
    seen[key] = true;
    out.push(streams[i]);
  }
  return out;
}

function buildStream(streamUrl, item, audioType, title) {
  var headers = { "User-Agent": DEFAULT_UA };
  if (item.referer) headers["Referer"] = item.referer;

  var quality = detectQuality(item.quality || streamUrl);
  var qualityLabel = quality > 0 ? String(quality) + "p" : "Auto";
  var label = "Animeya " + audioType.toUpperCase() + " " + qualityLabel;

  return {
    name: label,
    title: title,
    url: streamUrl,
    quality: qualityLabel,
    type: "direct",
    headers: headers
  };
}

/* Convert a decrypted bundle into a list of stream objects. Never rejects. */
function collectFromBundle(bundle, audioType, title) {
  var out = [];
  if (!bundle || !Array.isArray(bundle.sources)) return out;
  for (var i = 0; i < bundle.sources.length; i++) {
    var item = bundle.sources[i];
    if (!item || typeof item !== "object") continue;
    var streamUrl = item.url || item.file || "";
    if (!streamUrl) continue;
    out.push(buildStream(streamUrl, item, audioType, title));
  }
  return out;
}

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var id = String(tmdbId || "").trim();
  if (!id) return Promise.resolve([]);

  var isMovie = mediaType === "movie";
  var wantedSeason = isMovie ? 1 : Number(seasonNum) || 1;
  var wantedEpisode = isMovie ? 1 : Number(episodeNum) || 1;
  var title =
    mediaType === "movie"
      ? "Movie " + id
      : "S" + pad2(wantedSeason) + "E" + pad2(wantedEpisode);

  logStep("start " + id + " " + mediaType + " S" + wantedSeason + "E" + wantedEpisode);

  return mapAnilistFromTmdb(id, mediaType)
    .then(function (anilistId) {
      if (!anilistId) {
        logStep("no anilist mapping for " + id);
        return [];
      }
      logStep("anilist=" + anilistId + " ep=" + wantedEpisode);

      /* Fetch animehub and aniwave (both hard-sub) in PARALLEL and resolve
       * with the first one that yields streams. VidNest is slow, so racing
       * both gives the fastest positive answer and hides per-host latency. */
      function raceFirst(bundles) {
        return new Promise(function (resolve) {
          var left = bundles.length;
          for (var i = 0; i < bundles.length; i++) {
            bundles[i].then(function (n) {
              var list = n !== null ? collectFromBundle(n, "sub", title) : [];
              if (list.length > 0) {
                resolve(list);
              } else if (--left === 0) {
                resolve([]);
              }
            });
          }
        });
      }

      var fetches = [
        fetchSources(anilistId, wantedEpisode, "sub", "animehub"),
        fetchSources(anilistId, wantedEpisode, "sub", "aniwave_hls")
      ];

      return raceFirst(fetches).then(function (winners) {
        if (winners.length > 0) return winners;

        /* Both sub hosts empty - fall back to dub on animehub. */
        return fetchSources(anilistId, wantedEpisode, "dub", "animehub").then(function (n) {
          return n !== null ? collectFromBundle(n, "dub", title) : [];
        });
      });
    })
    .then(function (finalList) {
      logStep("returning " + finalList.length + " stream(s)");
      return dedupe(finalList);
    })
    .catch(function (err) {
      logStep("error: " + (err && err.message ? err.message : String(err)));
      return [];
    });
}

/* Export for Nuvio / React Native compatibility (Hermes) */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}