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
 * "aniwave_hls" returns a second hard-subbed host. The "hianime/anime" path
 * returns soft VTT tracks instead and is therefore skipped here.
 *
 * No backend is required - the public API is scraped directly from inside
 * Nuvio's QuickJS runtime. Written against ES5-safe constructs so it runs
 * even in older QuickJS builds.
 */
var VIDNEST_API = "https://new.vidnest.fun";
var VIDNEST_REFERER = "https://megaplay.buzz/";
var MAPPING_BASE = "https://api.ani.zip/mappings";
var DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

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

/* fetch helper with a timeout guard. Tries with the VidNest origin headers
 * first; if the sandbox rejects them it retries with minimal ones. */
function fetchText(url, originHeaders) {
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
      if (withHeaders && originHeaders) {
        headers["User-Agent"] = DEFAULT_UA;
        headers["Origin"] = VIDNEST_REFERER;
        headers["Referer"] = VIDNEST_REFERER;
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
  return fetchText(url, true).then(function (text) {
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

/* Fetch one VidNest source bundle for an episode and decrypt it. Returns the
 * parsed JSON (sources: [{url, quality, type, server, referer}], multiSrc,
 * intro, outro) or null when nothing is found. */
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
    encodeURIComponent(type) +
    (endpoint.indexOf("hianime") === 0 ? "/hd-2" : "");

  /* VidNest intermittently answers empty/non-JSON when rate limited, so retry
   * a couple of times before giving up. */
  var attempts = 0;

  var tryOnce = function () {
    attempts++;
    return getJson(url).then(function (raw) {
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
    });
  };

  return tryOnce().then(function (parsed) {
    if (parsed) return parsed;
    if (attempts >= 3) return null;
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve(
          tryOnce().then(function (again) {
            if (again) return again;
            if (attempts >= 3) return null;
            return new Promise(function (resolve2) {
              setTimeout(function () {
                resolve2(tryOnce());
              }, 700);
            });
          })
        );
      }, 700);
    });
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
  return "hls";
}

/* Fetch the source's own referer (from the API response) and pass it as the
 * stream header. The m3u8 also resolves without it, but sending it is safer. */
function fetchStreamHeaders(referer) {
  var headers = {};
  if (referer) headers["Referer"] = referer;
  headers["User-Agent"] = DEFAULT_UA;
  return headers;
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

function buildStream(streamUrl, audioType, title, headers, quality, viaEndpoint) {
  var label =
    "Animeya " + audioType.toUpperCase() + (quality > 0 ? " " + quality + "p" : "");
  return {
    name: label,
    title: title,
    url: streamUrl,
    quality: quality > 0 ? quality : 1080,
    provider: "vidnest",
    format: formatFromUrl(streamUrl),
    headers: headers
  };
}

function collectFromBundle(bundle, audioType, title, viaEndpoint) {
  if (!bundle || !Array.isArray(bundle.sources) || bundle.sources.length === 0) {
    return Promise.resolve([]);
  }
  var seen = Object.create(null);
  var jobs = [];
  for (var i = 0; i < bundle.sources.length; i++) {
    var item = bundle.sources[i];
    if (!item || typeof item !== "object") continue;
    var streamUrl = item.url || item.file || "";
    if (!streamUrl) continue;
    if (seen[streamUrl]) continue;
    seen[streamUrl] = true;
    jobs.push(resolveOne(streamUrl, item, audioType, title, viaEndpoint));
  }
  return Promise.all(jobs).then(function (parts) {
    var out = [];
    for (var j = 0; j < parts.length; j++) {
      if (parts[j]) out.push(parts[j]);
    }
    return out;
  });
}

function resolveOne(streamUrl, item, audioType, title, viaEndpoint) {
  var headers = fetchStreamHeaders(item.referer);
  /* Best effort quality: prefer RESOLUTION lines in a master playlist; else
   * fall back to hints in the source URL. (No segment probing here - hosts
   * like imgnex are referer-locked, so keep it light.) */
  return fetchText(streamUrl, false).then(function (playlistText) {
    var quality = maxPlaylistResolution(playlistText);
    if (quality <= 0) quality = detectQuality(item.quality || streamUrl);
    return buildStream(streamUrl, audioType, title, headers, quality, viaEndpoint);
  }).catch(function () {
    var quality = detectQuality(item.quality || streamUrl);
    return buildStream(streamUrl, audioType, title, headers, quality, viaEndpoint);
  });
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
      if (!anilistId) return [];

      /* 1) "animehub" = hard-subbed encodes (burned in, no subtitle track).
       * Some titles have no animehub source; fall back to 2) "aniwave_hls"
       * (also hard-subbed, different host). Sub and dub are separate calls. */
      var endpoints = ["animehub", "aniwave_hls"];
      var work = [];

      for (var e = 0; e < endpoints.length; e++) {
        (function (endpoint) {
          work.push(
            fetchSources(anilistId, wantedEpisode, "sub", endpoint).then(function (bundle) {
              return collectFromBundle(bundle, "sub", title, endpoint);
            })
          );
          work.push(
            fetchSources(anilistId, wantedEpisode, "dub", endpoint).then(function (bundle) {
              return collectFromBundle(bundle, "dub", title, endpoint);
            })
          );
        })(endpoints[e]);
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