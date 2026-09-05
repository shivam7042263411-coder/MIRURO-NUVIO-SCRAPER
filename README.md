# AniDap Anime Provider for Nuvio

A Nuvio-compatible anime provider plugin that **scrapes hard-subbed anime
sources directly from [AniDap](https://anidap.lol)** and returns playable HLS
streams for playback inside [Nuvio](https://nuvio.wiki).

No backend, no self-hosted helper, no accounts needed. The provider runs fully
inside Nuvio's QuickJS runtime and makes direct requests to AniDap's public
API. It maps the incoming TMDB id to AniDap's anime, lists the episodes, and
resolves direct `.m3u8` HLS streams (sub *and* dub where available).

> Plugins run code on your device. Only install repositories you trust, and
> use them in compliance with the laws in your jurisdiction.

---

## How it works

1. Nuvio invokes the provider with a **TMDB id**, media type, and season/episode.
2. The provider maps the TMDB id to an **AniList id** via
   [`api.ani.zip/mappings`](https://ani.zip).
3. It resolves AniDap's **slug** for that AniList id via AniDap's detail API.
4. It lists the anime's episodes, then resolves **direct `.m3u8` sources** for
   the requested episode (sub + dub).
5. It returns normalized Nuvio stream objects with the correct playback
   `Referer` / `User-Agent` headers.

Verified end-to-end: search → detail → episodes → sources all return playable
data with no auth cookies required (rate limit ~100/min).

---

## Requirements

- **Nuvio** sideloaded build (app-store builds do not support plugins).
- Internet access to `anidap.lol`, `chad.anidap.lol`, and `api.ani.zip`.
- A Nuvio account (optional, for cross-device plugin sync).

---

## Install

1. Open **Settings → Content & Discovery → Plugins** in Nuvio.
2. Choose **Add Repository**.
3. Paste your repository's raw manifest URL, e.g.:
   ```
   https://raw.githubusercontent.com/<user>/<repo>/refs/heads/main/manifest.json
   ```
4. **Refresh** to fetch the provider list.
5. **Enable the "AniDap Anime" provider** (adding the repo alone doesn't turn
   it on). You may also need the global *"Enable plugin providers"* toggle.

**Via the website:**

1. Log in at the Nuvio website → **Account** tab → **Plugins** in the sidebar.
2. **Add Plugin / Add Repository**, paste the manifest URL, name it, save.

### Verify

Open any anime title and check its source list — "AniDap SUB/DUB …" entries
with quality labels should appear alongside your other addon sources.

---

## Local development & testing

```bash
# Serve your providers/ and manifest.json over HTTP for the Plugin Tester
npx serve . -l 3000
```

Then in Nuvio's development build: **Settings → Developer → Plugin Tester**,
enter `http://<your-ip>:3000/manifest.json`, fetch, and test the provider.

> The app runs providers in a QuickJS sandbox. The shipped `providers/miruro.js`
> is a single self-contained file (no `import`/`require` of local dependencies),
> which is exactly what Nuvio's runtime expects.

---

## Repository layout

```
.
├── manifest.json           # Plugin repository manifest (provider registry)
├── providers/
│   └── miruro.js           # Single-file AniDap provider (getStreams)
├── docs/
│   └── API_NOTES.md        # AniDap API endpoints used
├── LICENSE                 # MIT
├── .gitignore
└── README.md
```

---

## Stream object format

The provider returns an array of Nuvio-compatible stream objects:

```javascript
{
  name: "AniDap SUB 720p",             // Provider label + audio/quality
  title: "S01E01",                     // Episode descriptor
  url: "https://.../master.m3u8",      // Playable HLS URL
  quality: 720,
  provider: "anidap",
  format: "m3u8",
  headers: {                           // Required for playback
    Referer: "https://megaplay.buzz/",
    "User-Agent": "Mozilla/5.0 ..."
  }
}
```

---

## AniDap API endpoints used

| Purpose | Endpoint |
|---|---|
| Anime detail (slug) | `GET /api/anime/{anilist_id}` |
| Episode list | `GET https://chad.anidap.lol/rest/api/episodes?id={slug}` |
| Direct sources | `GET https://chad.anidap.lol/rest/api/sources?id={slug}&epNum={n}&type={sub|dub}&providerId=yuki` |

See [`docs/API_NOTES.md`](docs/API_NOTES.md) for response shapes and notes.

---

## Disclaimer

This project is for educational and interoperability purposes. It does not host
or distribute any copyrighted content; it only resolves stream URLs from
AniDap. Users are responsible for complying with applicable laws and each
source's terms of service. AniDap and Nuvio are trademarks of their respective
owners; this project is independent and not affiliated with or endorsed by them.