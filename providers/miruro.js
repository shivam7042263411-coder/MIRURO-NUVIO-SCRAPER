/*
 * AniDap Anime provider for Nuvio
 *
 * Scrapes hard-subbed anime sources from AniDap (anidap.lol) and returns
 * playable HLS streams for Nuvio playback. The provider:
 *
 *   1. Maps the incoming TMDB id to an AniList id via ani.zip.
 *   2. Resolves the AniDap slug for that AniList id.
 *   3. Resolves direct .m3u8 sources for the requested episode.
 *
 * Sources: AniDap's "megaplay" provider serves hard-subbed (burned-in)
 * 1080p HLS encodes with zero soft-sub tracks - the AnimePahe experience.
 * "yuki" is used as a fallback for titles megaplay has no source for;
 * yuki offers soft (VTT) subtitles instead.
 *
 * No backend is required - AniDap's public API is scraped directly from
 * inside Nuvio's QuickJS runtime. Written against ES5-safe constructs so it
 * runs even in older QuickJS builds.
 */
var ANIDAP_BASE = "https://anidap.lol";
var ANIDAP_API = "https://chad.anidap.lol/rest/api";
var MAPPING_BASE = "https://api.ani.zip/mappings";
var SOURCE_PROVIDERS = ["megaplay", "yuki"];
var DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/* tiny in-memory caches so repeat taps are instant */
var caches = {
  mapping: Object.create(null),
  slug: Object.create(null),
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

/* Like fetchText but sends the CDN-provided headers (e.g. MegaPlay Referer)
 * that the stream host actually requires. No header fallback here because a
 * CDN like MegaPlay 403s without its Referer. */
function fetchTextWithHeaders(url, extraHeaders) {
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

    var headers = {};
    if (extraHeaders && typeof extraHeaders === "object") {
      for (var key in extraHeaders) {
        if (Object.prototype.hasOwnProperty.call(extraHeaders, key)) {
          headers[key] = extraHeaders[key];
        }
      }
    }
    headers["User-Agent"] = DEFAULT_UA;
    headers["Accept"] = "*/*";

    fetch(url, {
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
        cleanup();
        reject(err || new Error("fetch failed"));
      });
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

/* Parse a master HLS playlist and return the highest RESOLUTION found (or 0). */
function maxPlaylistResolution(text) {
  if (!text) return 0;
  var re = /RESOLUTION=(\d{3,5})x(\d{3,5})/g;
  var best = 0;
  var m;
  while ((m = re.exec(text)) !== null) {
    var h = parseInt(m[2], 10);
    if (h > best) best = h;
  }
  return best;
}

/* Find the first absolute segment URL in a media playlist. */
function firstSegmentUrl(playlistText) {
  if (!playlistText) return "";
  var lines = playlistText.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.length > 12 && /^https?:\/\//.test(line)) return line;
  }
  return "";
}

/* Read the real resolution out of the first segment's TS metadata when the
 * playlist is a flat single-rendition media playlist (playeng host). */
function probeSegmentResolution(segmentUrl, headers) {
  if (!segmentUrl) return Promise.resolve(0);
  var probeHeaders = {};
  for (var key in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, key)) probeHeaders[key] = headers[key];
  }
  probeHeaders["Range"] = "bytes=0-1024";
  probeHeaders["Accept"] = "*/*";

  return fetch(segmentUrl, { method: "GET", headers: probeHeaders })
    .then(function (res) {
      return res.text();
    })
    .then(function (body) {
      if (typeof body !== "string") return 0;
      var m = body.match(/(2160p|1440p|1080p|720p|480p|360p)/);
      if (!m) return 0;
      return parseInt(m[1], 10);
    })
    .catch(function () {
      return 0;
    });
}

/* Resolve direct .m3u8 sources for one episode from a specific provider.
 * "hard" distinguishes hard-subbed (megaplay) from soft-VTT (yuki) encodes. */
function fetchSources(slug, episodeNum, audioType, providerId, hard, title) {
  var type = audioType || "sub";
  var cacheKey = slug + "|" + episodeNum + "|" + type + "|" + providerId;
  var url =
    ANIDAP_API +
    "/sources?id=" +
    encodeURIComponent(slug) +
    "&epNum=" +
    encodeURIComponent(episodeNum) +
    "&type=" +
    encodeURIComponent(type) +
    "&providerId=" +
    encodeURIComponent(providerId);

  return getJsonCached(url, cacheKey, caches.sources).then(function (payload) {
    var out = [];
    if (!payload || typeof payload !== "object") return out;
    if (payload.error || payload.success === false) return out;
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

    var jobs = [];
    for (var i = 0; i < sources.length; i++) {
      var item = sources[i];
      if (!item || typeof item !== "object") continue;
      var streamUrl = item.url || "";
      if (!streamUrl) continue;
      jobs.push(resolveOne(item, streamUrl, type, providerId, hard, title, headers));
    }

    return Promise.all(jobs).then(function (parts) {
      for (var j = 0; j < parts.length; j++) {
        if (parts[j]) out.push(parts[j]);
      }
      return out;
    });
  });
}

function resolveOne(item, streamUrl, type, providerId, hard, title, headers) {
  /* Best effort: label with the true max quality. Prefer RESOLUTION lines in
   * a master playlist; otherwise probe the first segment's TS metadata;
   * finally fall back to whatever the URL/API hints at. */
  return fetchTextWithHeaders(streamUrl, headers)
    .then(function (text) {
      var quality = maxPlaylistResolution(text);
      if (quality > 0) {
        return buildStream(streamUrl, type, providerId, hard, title, headers, quality);
      }
      var segUrl = firstSegmentUrl(text);
      return probeSegmentResolution(segUrl, headers).then(function (prob) {
        if (prob > 0) {
          return buildStream(streamUrl, type, providerId, hard, title, headers, prob);
        }
        var q = detectQuality(item.quality || streamUrl);
        return buildStream(streamUrl, type, providerId, hard, title, headers, q);
      });
    })
    .catch(function () {
      var q = detectQuality(item.quality || streamUrl);
      return buildStream(streamUrl, type, providerId, hard, title, headers, q);
    });
}

function buildStream(streamUrl, type, providerId, hard, title, headers, quality) {
  var label = hard
    ? "AniDap " + (quality > 0 ? quality + "p" : "HD")
    : "AniDap " + type.toUpperCase() + (quality > 0 ? " " + quality + "p" : "");
  return {
    name: label,
    title: title,
    url: streamUrl,
    quality: quality > 0 ? quality : 1080,
    provider: "anidap",
    format: formatFromUrl(streamUrl),
    headers: headers
  };
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

      /* Try the hard-subbed source first (megaplay = AnimePahe-style).
       * megaplay can return "provider not found" for dub, so it is only
       * requested in sub form (dual audio). Fall back to yuki soft-subs for
       * both sub and dub. */
      var work = [];

      if (isMovie) {
        work.push(
          fetchSources(slug, 1, "sub", "megaplay", true, title).then(function (hardSubs) {
            if (hardSubs && hardSubs.length) return hardSubs;
            return Promise.all([
              fetchSources(slug, 1, "sub", "yuki", false, title),
              fetchSources(slug, 1, "dub", "yuki", false, title)
            ]).then(function (results) {
              return results[0].concat(results[1]);
            });
          })
        );
      } else {
        work.push(
          fetchSources(slug, wantedEpisode, "sub", "megaplay", true, title).then(function (hardSubs) {
            if (hardSubs && hardSubs.length) return hardSubs;
            return Promise.all([
              fetchSources(slug, wantedEpisode, "sub", "yuki", false, title),
              fetchSources(slug, wantedEpisode, "dub", "yuki", false, title)
            ]).then(function (results) {
              return results[0].concat(results[1]);
            });
          })
        );
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
    })
    .catch(function () {
      return [];
    });
}

module.exports = { getStreams };