# Miruro API Notes

This document describes the Miruro API endpoints the Nuvio provider relies on.
It assumes you run a self-hosted instance of a reverse-engineered Miruro API
(e.g. [walterwhite-69/Miruro-API](https://github.com/walterwhite-69/Miruro-API)).

## Base URL

Configurable at the top of `providers/miruro.js` as `MIRURO_API_BASE`.
Defaults to `http://localhost:8000`.

---

## 1. Get episodes

```
GET /episodes/{anilist_id}
```

Returns the anime's episodes across multiple sources (`kiwi`, `arc`, `zoro`,
`hop`, ...), organized by audio category (`sub` / `dub`).

### Example response

```json
{
  "mappings": {
    "anilistId": 178005,
    "malId": 56885
  },
  "providers": {
    "kiwi": {
      "episodes": {
        "sub": [
          {
            "id": "watch/kiwi/178005/sub/animepahe-1",
            "number": 1,
            "title": "Episode 1",
            "image": "https://...",
            "airDate": "2026-01-04",
            "duration": 1420
          }
        ],
        "dub": []
      }
    }
  }
}
```

### Fields the provider uses

- `providers.*.episodes.<category>[].id` — the watch path/slug.
- `providers.*.episodes.<category>[].number` — episode number (matched against
  the requested `episodeNum`).
- The audio category key (`sub`/`dub`) is preserved into the stream label.

Normalization is flexible: the provider also tolerates the audio object being a
flat array, and episode id variants (`episodeId`, `slug`) as well as number
variants (`episode`, `ep`).

---

## 2. Get streaming sources

```
GET /watch/{provider}/{anilistId}/{category}/{slug}
```

or, passing the episode `id` directly when it already starts with `watch/`:

```
GET /{id}
```

### Example response

```json
{
  "streams": [
    { "url": "https://cdn.../master.m3u8", "type": "hls", "quality": "1080p" }
  ],
  "subtitles": [
    { "file": "https://.../subs.vtt", "label": "English", "kind": "captions" }
  ],
  "intro": { "start": 0, "end": 90 },
  "outro": { "start": 1300, "end": 1420 }
}
```

### Fields the provider uses

- `streams[].url` (also tolerated: `file`, `src`, `link`, `stream`, `hls`,
  `mp4`, or a top-level `url`/`stream`/`hls`).
- Quality is detected from the URL or item payload and used for the stream
  label (`1080p`, `720p`, ...).

---

## 3. TMDB → AniList mapping

The provider uses the public [Ani.zip](https://ani.zip) mappings API to convert
the incoming Nuvio TMDB id into an AniList id:

```
GET https://api.ani.zip/mappings?themoviedb_id={tmdbId}        (series)
GET https://api.ani.zip/mappings?themoviedb_movie_id={tmdbId}  (movie)
```

If mapping fails, the provider resolves to no streams rather than erroring.

---

## Response-shape tolerance

The provider is intentionally lenient about source payload shapes. It walks
`streams` / `sources` / `result` / `data` / `response` roots and accepts bare
arrays, so it continues to work across Miruro API implementations that wrap the
documented response in extra envelope layers.
