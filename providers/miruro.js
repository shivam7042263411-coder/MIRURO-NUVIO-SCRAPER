/*
 * Miruro Anime provider for Nuvio
 *
 * Fetches playable HLS streams for anime titles from Miruro through a
 * self-hosted Miruro API backend. The provider maps an incoming TMDB id to
 * an AniList id, lists the anime's episodes, locates the requested episode,
 * and resolves its streaming sources.
 *
 * NOTE: Miruro itself is protected by Cloudflare, so this plugin talks to a
 * self-hosted Miruro API instance that you run yourself (see README). Point
 * MIRURO_API_BASE at that instance.
 */
var MIRURO_API_BASE = "http://localhost:8000";
var MAPPING_BASE = "https://api.ani.zip/mappings";
var DEFAULT_UA =
  "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36";

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function getJson(url) {
  return fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent": DEFAULT_UA,
    },
  })
    .then(function (res) {
      if (!res.ok) return null;
      return res.text();
    })
    .then(function (text) {
      if (!text) return null;
      return safeParseJson(text);
    })
    .catch(function () {
      return null;
    });
}

/* Map a TMDB id (movie or tv) to an AniList id using Ani.zip's public mapping. */
function mapAnilistFromTmdb(tmdbId, mediaType) {
  if (!tmdbId) return Promise.resolve("");

  var field = mediaType === "movie" ? "themoviedb_movie_id" : "themoviedb_id";
  return getJson(
    MAPPING_BASE + "?" + field + "=" + encodeURIComponent(String(tmdbId))
  ).then(function (parsed) {
    if (!parsed || typeof parsed !== "object") return "";
    var mappings = parsed.mappings || {};
    var mapped = mappings.anilist_id;
    return mapped !== undefined && mapped !== null ? String(mapped) : "";
  });
}

/* Normalize the episodes response into a flat list of { provider, category, id, number }. */
function flattenEpisodes(payload) {
  var out = [];
  if (!payload || typeof payload !== "object") return out;
  var providers = payload.providers || {};
  var providerKeys = Object.keys(providers);
  for (var p = 0; p < providerKeys.length; p++) {
    var providerName = providerKeys[p];
    var provider = providers[providerName];
    if (!provider || typeof provider !== "object") continue;
    var audio = provider.episodes || provider.audio || {};
    if (Array.isArray(audio)) {
      collectEpisodesInAudio(out, providerName, "sub", audio);
      continue;
    }
    var audioKeys = Object.keys(audio);
    for (var a = 0; a < audioKeys.length; a++) {
      var category = audioKeys[a];
      var list = audio[category];
      if (Array.isArray(list)) {
        collectEpisodesInAudio(out, providerName, category, list);
      }
    }
  }
  return out;
}

function collectEpisodesInAudio(out, providerName, category, list) {
  for (var i = 0; i < list.length; i++) {
    var ep = list[i];
    if (!ep || typeof ep !== "object") continue;
    var id = ep.id || ep.episodeId || ep.slug || "";
    var number = ep.number || ep.episode || ep.ep;
    if (!id || number === undefined || number === null) continue;
    out.push({
      provider: providerName,
      category: category,
      id: String(id),
      number: Number(number),
    });
  }
}

/* Resolve the direct M3U8 URL(s) out of the sources payload. */
function pullStreamUrls(payload) {
  var out = [];

  function pushUrl(u) {
    if (typeof u === "string" && u) out.push(u);
  }

  if (!payload || typeof payload !== "object") return out;

  if (Array.isArray(payload)) {
    for (var i = 0; i < payload.length; i++) {
      var item = payload[i];
      if (item && typeof item === "object") {
        pushUrl(
          item.url ||
            item.file ||
            item.src ||
            item.link ||
            item.stream ||
            item.hls ||
            item.links && item.links.stream
        );
      } else if (typeof item === "string") {
        pushUrl(item);
      }
    }
    return out;
  }

  var streamsRoot =
    payload.streams ||
    payload.sources ||
    payload.result ||
    payload.data ||
    payload.response;

  if (Array.isArray(streamsRoot)) {
    for (var j = 0; j < streamsRoot.length; j++) {
      var s = streamsRoot[j];
      if (s && typeof s === "object") {
        pushUrl(s.url || s.file || s.src || s.link || s.stream || s.hls || s.mp4);
      }
    }
  }

  if (payload.url) pushUrl(payload.url);
  if (payload.stream) pushUrl(payload.stream);
  if (payload.hls) pushUrl(payload.hls);

  return out;
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

function dedupe(urls) {
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < urls.length; i++) {
    var u = urls[i];
    if (!u || seen[u]) continue;
    seen[u] = true;
    out.push(u);
  }
  return out;
}

/* Find stream URLs for a single episode source id. */
function fetchWatch(anilistId, provider, category, episodeId, title) {
  var id = String(episodeId);
  // id may already start with "watch/..." or just be the slug
  var path = id.indexOf("watch/") === 0 ? id : "watch/" + provider + "/" + anilistId + "/" + category + "/" + id;
  var url = MIRURO_API_BASE + "/" + path;

  return getJson(url).then(function (parsed) {
    var urls = pullStreamUrls(parsed);
    var out = [];
    for (var i = 0; i < urls.length; i++) {
      var streamUrl = urls[i];
      var quality = detectQuality(streamUrl) || 720;
      out.push({
        name: "Miruro " + provider + "-" + category + " " + quality + "p",
        title: title,
        url: streamUrl,
        quality: quality,
        provider: "miruro",
        format: formatFromUrl(streamUrl),
        headers: {
          Referer: "https://miruro.tv/",
          Origin: "https://miruro.tv",
          "User-Agent": DEFAULT_UA,
        },
      });
    }
    return out;
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
      : "S" + String(wantedSeason).padStart(2, "0") + "E" + String(wantedEpisode).padStart(2, "0");

  return mapAnilistFromTmdb(id, mediaType)
    .then(function (anilistId) {
      if (!anilistId) return { anilistId: "", episodes: [] };
      return getJson(MIRURO_API_BASE + "/episodes/" + anilistId).then(function (payload) {
        return { anilistId: anilistId, episodes: flattenEpisodes(payload) };
      });
    })
    .then(function (data) {
      if (!data.anilistId) return [];
      var matches = [];
      for (var i = 0; i < data.episodes.length; i++) {
        var ep = data.episodes[i];
        if (ep.number === wantedEpisode) matches.push(ep);
      }
      if (matches.length === 0) return [];

      var work = matches.map(function (ep) {
        return fetchWatch(data.anilistId, ep.provider, ep.category, ep.id, title);
      });

      return Promise.all(work).then(function (results) {
        var merged = [];
        for (var r = 0; r < results.length; r++) {
          var part = results[r] || [];
          for (var k = 0; k < part.length; k++) {
            merged.push(part[k]);
          }
        }
        return merged;
      });
    })
    .catch(function () {
      return [];
    });
}

module.exports = { getStreams };
