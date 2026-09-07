/*
 * AnimePahe source for Nuvio (on-device).
 *
 * Everything runs inside Nuvio, from the TV/phone's own home IP. The only
 * thing this provider needs from you is a valid cf_clearance cookie, solved
 * once in a normal browser on the SAME network (see PAHE_COOKIE below).
 *
 * The cookie is bound to the IP + User-Agent that solved it, so:
 *   - solve in a browser while on the SAME Wi-Fi as the TV/phone, and
 *   - set PAHE_UA to the exact User-Agent of that browser.
 */
var PAHE_BASE = "https://animepahe.pw";

/* Paste your cf_clearance cookie value here. Example:
 *   "cf_clearance=Abc123....=="
 * Get it from browser DevTools (Application -> Cookies -> animepahe.pw)
 * or from a cookie-extension export of the solved browser tab.
 */
var PAHE_COOKIE = "cf_clearance=q3Lb394.1pj7EnZdJiixB3CxLZngr8dJ1MBXb.C2_.A-1788788097-1.2.1.1-GHSE20JvJ4jCiKNPkovhDWw9SujEQbzq99W0dhtEbSU62XL8.SCec.mu7CShncCWaMD3IFWbABgEQoKyxnvCsZg6AbDM5g5SQT7mtGjfARglf27wvabAIaClJVsEtsHvEVKIdfJkjzFoqNKVjYkBrRyXtdmizbX7vJQfcYpOOvpJkDopXAQSwTnIVWYAq87zRhXJtffhUYABUsQ.O5XAIQPbvdqOYZXExkbrT1ORwNaqpagbwS4U7WFcQRAnLFo4sS3j0elyHVVJ8AEK70ILLPmzVNfmORFQFUDG8QCuAnnJ6C0Ktt_wRDZ_5emBWqpyHJF4ZM7HeOFD9mAsQ.wwXebf8GjpI9nv1jrfk_hiL0pxvdUxpvB4f1C4PllycoFrTjIIGNeMj8WLUd5qnuJwabZoKspavUnICBu9UCP6wZ30FcyN44vyFVh9mm1C.S9jY62UuPkjIrVSqTWLK55eU9zBK1uNzqUq6JeS3laWk32KTDIr9_c63BMlnkDvyg5.uMLWB.aRPIoaX.qGHUSYz.D_THp61pyxwps1pgycK6w.xt0X7MzLV.jFNCpHZqQGG0NM1lPddeAbJWCQJjLyshuvb2fTNM.R0p0RYL7lfk0M2G9v0ntVjmUGzio2zimSA3g2lUlGYEaBtU_6PaU2a7fJNqvxRsGQyoos6uZj1Lg";

/* Set to the exact User-Agent string of the browser that solved the cookie. */
var PAHE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

var KWIK_REFERER = "https://kwik.cx/";

/* Pre-seeded TMDB->AniList ids for titles without an ani.zip entry. */
var LOCAL_ANILIST = {
  "tv:1429": "16498",   /* Attack on Titan */
  "tv:37854": "21",     /* One Piece */
  "tv:94664": "108465", /* Mushoku Tensei */
  "tv:209867": "154587" /* Frieren */
};

function deadline(ms) {
  if (typeof setTimeout === "function") {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }
  var end = Date.now() + ms;
  function tick(resolve) {
    if (Date.now() >= end) resolve();
    else Promise.resolve().then(function () { tick(resolve); });
  }
  return new Promise(function (resolve) { tick(resolve); });
}

function safeParseJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

/* HTTP GET/POST with a hard deadline. Never rejects. */
function fetchBody(url, ms, method, body, headers) {
  return new Promise(function (resolve) {
    var done = false;
    function out(s, b) { if (!done) { done = true; resolve({ status: s, body: b }); } }
    deadline(ms).then(function () { out(0, ""); });
    if (typeof fetch !== "function") { out(-1, ""); return; }
    var init = { method: method || "GET", headers: headers || { "User-Agent": PAHE_UA } };
    if (body !== undefined && body !== null) init.body = body;
    fetch(url, init).then(function (r) {
      var st = r && typeof r.status === "number" ? r.status : 0;
      if (r && typeof r.text === "function") {
        r.text().then(function (t) { out(st, String(t || "")); });
      } else out(st, "");
    }).catch(function () { out(-2, ""); });
  });
}

function paheHeaders() {
  var h = {
    "User-Agent": PAHE_UA,
    "Referer": PAHE_BASE + "/",
    "Accept": "*/*"
  };
  if (PAHE_COOKIE && PAHE_COOKIE.indexOf("PASTE_ME") === -1) {
    h["Cookie"] = PAHE_COOKIE;
  }
  return h;
}

/* Map TMDB id -> AniList id (local seeds, then ani.zip). */
function mapAnilist(tmdbId, mediaType) {
  if (!tmdbId) return Promise.resolve("");
  var key = mediaType + ":" + tmdbId;
  if (LOCAL_ANILIST[key]) return Promise.resolve(LOCAL_ANILIST[key]);
  var field = mediaType === "movie" ? "themoviedb_movie_id" : "themoviedb_id";
  var url = "https://api.ani.zip/mappings?" + field + "=" + encodeURIComponent(String(tmdbId));
  return fetchBody(url, 1600).then(function (r) {
    var parsed = safeParseJson(r.body || "");
    var m = parsed && parsed.mappings ? parsed.mappings : null;
    return m && m.anilist_id !== undefined && m.anilist_id !== null ? String(m.anilist_id) : "";
  });
}

/* Get anime title + year from AniList GraphQL by id. */
function anilistTitle(anilistId) {
  var q = {
    query: "query($id:Int){Media(id:$id){title{romaji english} startDate{year}}}",
    variables: { id: Number(anilistId) }
  };
  return fetchBody(
    "https://graphql.anilist.co",
    2500,
    "POST",
    JSON.stringify(q),
    { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": PAHE_UA }
  ).then(function (r) {
    var parsed = safeParseJson(r.body || "");
    var media = parsed && parsed.data && parsed.data.Media ? parsed.data.Media : null;
    if (!media || !media.title) return null;
    return {
      title: media.title.romaji || media.title.english || "",
      english: media.title.english || media.title.romaji || "",
      year: media.startDate && media.startDate.year ? media.startDate.year : 0
    };
  });
}

function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/^\s+|\s+$/g, "");
}

/* pahe search -> best matching anime {id, title, episodes}. */
function paheSearchId(titleText, englishText, year) {
  function doSearch(q) {
    var url = PAHE_BASE + "/api?m=search&q=" + encodeURIComponent(q) + "&page=1";
    return fetchBody(url, 2500, "GET", null, paheHeaders()).then(function (r) {
      var parsed = safeParseJson(r.body || "");
      var data = parsed && Array.isArray(parsed.data) ? parsed.data : [];
      if (data.length === 0) return null;

      var wantRom = normalize(titleText);
      var wantEng = normalize(englishText);
      for (var i = 0; i < data.length; i++) {
        var it = data[i];
        var n = normalize(it.title);
        if (n && ((wantRom && n === wantRom) || (wantEng && n === wantEng))) return it;
      }
      /* Fuzzy: same first token + year match. */
      if (year) {
        for (var j = 0; j < data.length; j++) {
          var it2 = data[j];
          if (String(it2.year) === String(year) &&
              String(it2.title || "").toLowerCase().indexOf(String(titleText || "").slice(0, 8).toLowerCase()) !== -1) {
            return it2;
          }
        }
      }
      return data[0];
    });
  }

  return doSearch(titleText).then(function (hit) {
    if (hit) return hit;
    if (englishText && normalize(englishText) !== normalize(titleText)) return doSearch(englishText);
    return null;
  });
}

/* Release list -> session for one episode. */
function paheEpisodeSession(animeId, wantedEp, page) {
  var url = PAHE_BASE + "/api?m=release&id=" + encodeURIComponent(animeId) +
            "&sort=episode_asc&page=" + (page || 1);
  return fetchBody(url, 2500, "GET", null, paheHeaders()).then(function (r) {
    var parsed = safeParseJson(r.body || "");
    var data = parsed && Array.isArray(parsed.data) ? parsed.data : [];
    for (var i = 0; i < data.length; i++) {
      if (String(data[i].episode) === String(wantedEp)) {
        return { session: data[i].session, episode: data[i].episode };
      }
    }
    var next = parsed && parsed.next_page_url ? parsed.next_page_url : null;
    if (next && data.length > 0) return paheEpisodeSession(animeId, wantedEp, (page || 1) + 1);
    return null;
  });
}

/* Fetch pahe play page, extract the kwik embed. */
function pahePlayPage(animeId, session) {
  var url = PAHE_BASE + "/play/" + encodeURIComponent(animeId) + "/" + encodeURIComponent(session);
  var headers = paheHeaders();
  headers["Referer"] = PAHE_BASE + "/anime/" + encodeURIComponent(animeId);
  return fetchBody(url, 3000, "GET", null, headers).then(function (r) {
    return { html: r.body || "", url: url, status: r.status };
  });
}

function findKwik(html) {
  var patterns = [
    /data-src=["'](https?:\/\/(?:kwik\.cx|kwik\.si)\/e\/[^"']+)["']/,
    /<iframe[^>]*src=["'](https?:\/\/(?:kwik\.cx|kwik\.si)\/[^"']+)["']/,
    /data-src=["']([^"']*(?:kwik\.cx|kwik\.si)[^"']*)["']/
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = html.match(patterns[i]);
    if (m && m[1]) return m[1];
  }
  return "";
}

/* Swap scheme so an http:// kwik link still works: kwik uses https. */
function normalizeKwik(raw) {
  return String(raw || "").replace(/^http:\/\//, "https://");
}

/* Resolve a kwik embed -> direct m3u8.
 * Strategy: look for an absolute .m3u8 first; then capture the url fed to
 * Hls.Plyr.setup by running the page's own scripts in a mock sandbox. */
function resolveKwik(kwikUrl, referer) {
  var headers = {
    "User-Agent": PAHE_UA,
    "Referer": referer,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9"
  };
  return fetchBody(kwikUrl, 3000, "GET", null, headers).then(function (r) {
    var html = r.body || "";
    var direct = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/);
    if (direct && direct[0]) return direct[0];

    var script = extractSetupScript(html);
    if (script) {
      var captured = sandboxRun(script, kwikUrl);
      if (captured) return captured;
    }
    return "";
  });
}

function extractSetupScript(html) {
  var blocks = html.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [];
  for (var i = 0; i < blocks.length; i++) {
    var inner = blocks[i].replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    if (/Hls\.Plyr|Plyr\.setup|\.setup\s*\(|m3u8|uwu/.test(inner)) return inner;
  }
  return "";
}

/* Execute the kwik player script with mocked globals, capturing the URL it
 * passes to Hls.Plyr.setup (or a similar player). Pure JS, no browser. */
function sandboxRun(script, pageUrl) {
  try {
    var captured = "";
    var Hls = { Plyr: { setup: function (cfg) { captured = cfg && cfg.url ? cfg.url : ""; } } };
    var noop = function () {};
    var window = {
      location: { href: pageUrl, search: pageUrl.split("?").slice(1).join("?"), hash: "" },
      addEventListener: function () {}, removeEventListener: function () {},
      navigator: { userAgent: PAHE_UA },
      atob: function (s) { try { return atob(s); } catch (e) { return ""; } },
      btoa: function (s) { try { return btoa(s); } catch (e) { return ""; } },
      setTimeout: function (fn, ms) { setTimeout(fn, ms); },
      clearTimeout: function (id) { clearTimeout(id); },
      Hls: Hls, document: null
    };
    var document = {
      location: window.location, cookie: "", readyState: "complete",
      getElementById: function () { return null; },
      querySelector: function () { return null; },
      querySelectorAll: function () { return []; },
      addEventListener: function () {}, createElement: function () {
        return { setAttribute: function () {}, appendChild: function () {}, style: {}, addEventListener: function () {} };
      },
      body: { appendChild: function () {} },
      head: { appendChild: function () {} }
    };
    var navigator = { userAgent: PAHE_UA };
    var self = window;

    eval(script);
    return captured;
  } catch (e) {
    return "";
  }
}

function detectQuality(value) {
  if (value === undefined || value === null) return 0;
  var m = String(value).match(/(2160|1440|1080|720|480|360)/);
  return m ? parseInt(m[1], 10) : 0;
}

function pad2(n) {
  var s = String(n);
  return s.length > 1 ? s : "0" + s;
}

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var id = String(tmdbId || "").trim();
  if (!id || PAHE_COOKIE.indexOf("PASTE_ME") !== -1) {
    return Promise.resolve([]);
  }
  var isMovie = mediaType === "movie";
  var wantedEpisode = isMovie ? 1 : Number(episodeNum) || 1;
  var title = isMovie ? "Movie " + id : "S01E" + pad2(wantedEpisode);

  return mapAnilist(id, mediaType).then(function (anilistId) {
    if (!anilistId) return [];
    return anilistTitle(anilistId).then(function (info) {
      if (!info || !info.title) return [];
      return paheSearchId(info.title, info.english, info.year).then(function (anime) {
        if (!anime || !anime.id) return [];
        return paheEpisodeSession(anime.id, wantedEpisode, 1).then(function (found) {
          if (!found) return [];
          return pahePlayPage(anime.id, found.session).then(function (play) {
            var kwik = findKwik(play.html);
            if (!kwik) kwik = "https://kwik.cx/e/" + encodeURIComponent(found.session);
            return resolveKwik(normalizeKwik(kwik), play.url).then(function (m3u8) {
              if (!m3u8) return [];
              return [{
                name: "AnimePahe",
                title: title,
                url: m3u8,
                quality: "Auto",
                type: "direct",
                headers: {
                  "User-Agent": PAHE_UA,
                  "Referer": KWIK_REFERER
                }
              }];
            });
          });
        });
      });
    });
  }).catch(function () {
    return [];
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  var scope = (typeof global !== "undefined") ? global
            : (typeof globalThis !== "undefined") ? globalThis
            : (function () { return this; })();
  scope.getStreams = getStreams;
}
