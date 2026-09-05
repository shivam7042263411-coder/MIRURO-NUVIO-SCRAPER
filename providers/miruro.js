/*
 * AniDap Anime provider for Nuvio
 *
 * Scrapes hard-subbed anime sources from AniDap (anidap.lol) and returns
 * playable HLS streams for Nuvio playback. The provider:
 *
 *   1. Maps the incoming TMDB id to an AniList id via ani.zip.
 *   2. Resolves the AniDap slug for that AniList id.
 *   3. Resolves direct .m3u8 sources for the requested episode (sub/dub).
 *
 * No backend is required - AniDap's public API is scraped directly from
 * inside Nuvio's QuickJS runtime. Written against ES5-safe constructs so it
 * runs even in older QuickJS builds.
 */
var ANIDAP_BASE = "https://anidap.lol";
var ANIDAP_API = "https://chad.anidap.lol/rest/api";
var MAPPING_BASE = "https://api.ani.zip/mappings";
var DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/* tiny in-memory caches so repeat taps are instant */
var caches = {
  mapping: Object.create(null),
  slug: Object.create(null),
  episodes: Object.create(null),
  sources: Object.create(null)
};

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/* fetch helper with a timeout guard. Tries with full headers first; if the
 * sandbox rejects the headers it retries with minimal ones. */
function fetchText(url) {
  var timer = null;
  var timedOut = false;

  var cleanup = function () {
    if (timer) clearTimeout(timer);
  };

  return new Promise(function (resolve, reject) {
    timer = setTimeout(function () {
      timedOut = true;
      reject(new Error("timeout"));
    }, 8000);

    var attempt = function (withHeaders) {
      var headers = {
        Accept: "application/json, text/plain, */*"
      };
      if (withHeaders) {
        headers["User-Agent"] = DEFAULT_UA;
        headers["Referer"] = ANIDAP_BASE + "/";
      }
      return fetch(url, {
        method: "GET",
        headers: headers
      })
        .then(function (res) {
          return res.text();
        })
        .then(function (text) {
          cleanup();
          resolve(text);
        })
        .catch(function (err) {
          if (timedOut) return;
          if (withHeaders) {
            attempt(false);
          } else {
            cleanup();
            reject(err || new Error("fetch failed"));
          }
        });
    };
    attempt(true);
  });
}

function getJson(url) {
  return fetchText(url).then(function (text) {
    if (!text) return null;
    var parsed = safeParseJson(text);
    if (parsed && typeof parsed === "object" && parsed.success === false) return null;
    return parsed;
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

/* Map a TMDB id (movie or tv) to an AniList id using Ani.zip. */
function mapAnilistFromTmdb(tmdbId, mediaType) {
  if (!tmdbId) return Promise.resolve("");

  var field = mediaType === "movie" ? "themoviedb_movie_id" : "themoviedb_id";
  var url = MAPPING_BASE + "?" + field + "=" + encodeURIComponent(String(tmdbId));

  return getJsonCached(url, String(tmdbId) + ":" + mediaType, caches.mapping).then(function (parsed) {
    if (!parsed || typeof parsed !== "object") return "";
    var mappings = parsed.mappings || {};
    var mapped = mappings.anilist_id;
    return mapped !== undefined && mapped !== null ? String(mapped) : "";
  });
}

/* Resolve the AniDap slug for an AniList id. */
function fetchAnimeSlug(anilistId) {
  if (!anilistId) return Promise.resolve("");
  var url = ANIDAP_BASE + "/api/anime/" + encodeURIComponent(anilistId);

  return getJsonCached(url, anilistId, caches.slug).then(function (payload) {
    if (!payload || typeof payload !== "object") return "";
    var data = payload.data || payload;
    return typeof data.slug === "string" ? data.slug : "";
  });
}

/* Fetch the episode list for a slug (used only to verify the episode exists). */
function fetchEpisodes(slug) {
  if (!slug) return Promise.resolve([]);
  var url = ANIDAP_API + "/episodes?id=" + encodeURIComponent(slug) + "&refresh=false";

  return getJsonCached(url, slug, caches.episodes).then(function (payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.episodes)) return payload.episodes;
    if (payload && Array.isArray(payload.data)) return payload.data;
    return [];
  });
}

/* Resolve direct .m3u8 sources for one episode. */
function fetchSources(slug, episodeNum, audioType, title) {
  var type = audioType || "sub";
  var cacheKey = slug + "|" + episodeNum + "|" + type;
  var url =
    ANIDAP_API +
    "/sources?id=" +
    encodeURIComponent(slug) +
    "&epNum=" +
    encodeURIComponent(episodeNum) +
    "&type=" +
    encodeURIComponent(type) +
    "&providerId=yuki";

  return getJsonCached(url, cacheKey, caches.sources).then(function (payload) {
    var out = [];
    if (!payload || typeof payload !== "object") return out;
    var sources = payload.sources;
    if (!Array.isArray(sources)) return out;

    var headers = {};
    if (payload.headers && typeof payload.headers === "object") {
      for (var key in payload.headers) {
        if (Object.prototype.hasOwnProperty.call(payload.headers, key)) {
          headers[key] = payload.headers[key];
        }
      }
    }
    headers["User-Agent"] = DEFAULT_UA;

    for (var i = 0; i < sources.length; i++) {
      var item = sources[i];
      if (!item || typeof item !== "object") continue;
      var streamUrl = item.url || "";
      if (!streamUrl) continue;
      var quality = detectQuality(item.quality || streamUrl) || 720;
      out.push({
        name: "AniDap " + type.toUpperCase() + " " + quality + "p",
        title: title,
        url: streamUrl,
        quality: quality,
        provider: "anidap",
        format: formatFromUrl(streamUrl),
        headers: headers
      });
    }
    return out;
  });
}

function detectQuality(value) {
  if (value === undefined || value === null) return 0;
  var str = String(value);
  var match = str.match(/(2160|1440|1080|720|480|360)/);
  return match ? parseInt(match[1], 10) : 0;
}

function formatFromUrl(url) {
  var lower = String(url || "").toLowerCase();
  if (lower.indexOf(".m3u8") !== -1) return "m3u8";
  if (lower.indexOf(".mp4") !== -1) return "mp4";
  if (lower.indexOf(".mkv") !== -1) return "mkv";
  return "hls";
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

  return mapAnilistFromTmdb(id, mediaType)
    .then(function (anilistId) {
      if (!anilistId) return "";
      return fetchAnimeSlug(anilistId);
    })
    .then(function (slug) {
      if (!slug) return [];
      var types = isMovie ? ["sub"] : ["sub", "dub"];

      return fetchEpisodes(slug).then(function (episodes) {
        var exists =
          episodes.length === 0 ||
          episodes.some(function (ep) {
            return Number(ep.number) === wantedEpisode;
          });
        if (!exists) return [];

        var work = [];
        for (var t = 0; t < types.length; t++) {
          work.push(fetchSources(slug, wantedEpisode, types[t], title));
        }
        return Promise.all(work).then(function (results) {
          var merged = [];
          for (var r = 0; r < results.length; r++) {
            var part = results[r] || [];
            for (var k = 0; k < part.length; k++) {
              merged.push(part[k]);
            }
          }
          return dedupe(merged);
        });
      });
    })
    .catch(function () {
      return [];
    });
}

module.exports = { getStreams };