# AniDap API Notes

This document describes the AniDap API endpoints the Nuvio provider relies on.
All endpoints are public (no auth, no cookies) but require a browser
`User-Agent` and a `Referer` of `https://anidap.lol/`. AniDap rate-limits to
about 100 requests/min per IP.

Headers required for every request:

```
User-Agent: Mozilla/5.0 (Macintosh; ...) AppleWebKit/537.36 ... Chrome/126.0 Safari/537.36
Referer: https://anidap.lol/
Accept: application/json
```

---

## 1. Map TMDB → AniList

The provider uses the public [Ani.zip](https://ani.zip) mappings API:

```
GET https://api.ani.zip/mappings?themoviedb_id={tmdbId}        (series)
GET https://api.ani.zip/mappings?themoviedb_movie_id={tmdbId}  (movie)
```

Extracts `mappings.anilist_id`.

---

## 2. Anime detail (get the slug)

```
GET https://anidap.lol/api/anime/{anilist_id}
```

Returns a JSON payload whose `data` object contains `slug`, `tmdbId`,
`anilistId`, `episodeCount`, `seasons`, and metadata. The provider takes
`data.slug` as the identifier used in the streaming endpoints.

---

## 3. Episode list

```
GET https://chad.anidap.lol/rest/api/episodes?id={slug}&refresh=false
```

Returns an array of episodes:

```json
[
  {
    "number": 1,
    "titles": { "en": "Jobless Reincarnation", "ja": "無職転生" },
    "isFiller": false,
    "hasDub": true,
    "hasSub": true
  }
]
```

The provider matches `episode.number` against the requested `episodeNum`.

---

## 4. Direct sources

```
GET https://chad.anidap.lol/rest/api/sources?id={slug}&epNum={n}&type={sub|dub}&providerId=yuki
```

Returns direct playable HLS:

```json
{
  "sources": [
    {
      "url": "https://vault-98.akirax.buzz/anime/.../master.m3u8",
      "quality": "auto",
      "type": "video/mpegurl"
    }
  ],
  "tracks": [
    { "id": "captions-1", "url": "https://.../subtitles/eng-2.vtt", "label": "English", "kind": "captions" }
  ],
  "audio": null,
  "chapters": [{ "title": "Outro", "start": 1332, "end": 1427 }],
  "headers": { "Referer": "https://megaplay.buzz/" }
}
```

The provider takes each `sources[].url`, detects quality from the URL, and
merges the returned `headers` with the playback `User-Agent`.

---

## Notes

- `providerId=yuki` serves hard-subbed episodes (AnimePahe-style burned-in
  subs). Other provider ids exist; `yuki` is the verified default.
- `type=sub` / `type=dub` select audio; dub is attempted for TV where
  available and skipped when the episode has none.
- Movies resolve as episode 1 (`sub` only).
- Response shapes are tolerated leniently: `episodes` responses that are
  wrapped in `{ episodes: [] }` or `{ data: [] }` are handled, and failed
  `success: false` responses are treated as no data rather than errors.