# Miruro Anime Provider for Nuvio

A Nuvio-compatible anime provider plugin that searches anime and lists episodes,
then retrieves playable video sources (HLS/M3U8) from **Miruro** for playback
inside [Nuvio](https://nuvio.wiki).

Because Miruro is behind Cloudflare, this plugin talks to a **self-hosted
Miruro API backend** that you run yourself. It does **not** scrape Miruro
directly from the Nuvio device. You run one lightweight API service, point the
plugin at it, and the provider handles TMDB → AniList mapping, episode lookup,
and source resolution locally inside Nuvio's QuickJS runtime.

> Plugins run code on your device. Only install repositories you trust, and
> use them in compliance with the laws in your jurisdiction.

---

## How it works

1. Nuvio invokes the provider with a TMDB id, media type, and season/episode.
2. The provider maps the TMDB id to an **AniList id** via
   [`api.ani.zip/mappings`](https://ani.zip).
3. It fetches the anime's episode list from the Miruro API:
   `GET /episodes/{anilist_id}`.
4. It picks episodes matching the requested episode number (sub + dub).
5. It resolves playable streams through the Miruro API:
   `GET /watch/{provider}/{anilistId}/{category}/{slug}`.
6. It returns normalized Nuvio stream objects (HLS URLs + referer headers).

---

## Requirements

- **Nuvio** sideloaded build (app-store builds do not support plugins).
- A self-hosted **Miruro API** instance (the provider's data backend).
  - Recommended: [walterwhite-69/Miruro-API](https://github.com/walterwhite-69/Miruro-API) (Python/FastAPI).
  - Alternatives exist too — any backend exposing the Miruro API endpoints
    described below will work.
- A Nuvio account (optional, for cross-device plugin sync).

> **Cloudflare note:** Miruro's own pipe endpoint is behind Cloudflare. The
> Miruro API project uses `curl_cffi` with Chrome TLS fingerprinting, which
> works from residential and most VPS IPs, but **not** from datacenter/CDN
> ranges (Vercel, Render free tier, app-hosting PaaS). Self-host on a clean
> VPS or locally.

---

## Setup

### 1. Run the Miruro API backend

```bash
git clone https://github.com/walterwhite-69/Miruro-API.git
cd Miruro-API
pip install -r requirements.txt
uvicorn api:app --host 0.0.0.0 --port 8000
```

This serves `http://localhost:8000` locally. For use from Nuvio on a phone/TV,
expose it on your LAN (e.g. `http://192.168.1.X:8000`) or a reachable URL, and
note that address — you'll point the plugin at it.

### 2. Point the provider at your backend

Edit `API_BASE` in `providers/miruro.js` to your Miruro API base URL:

```javascript
var MIRURO_API_BASE = "http://192.168.1.5:8000"; // your backend
```

> If you host your own fork of this repo, this file becomes your manifest's
> provider. For the simplest "set and forget" install, bake your API base in
> and push to GitHub so Nuvio fetches the updated provider.

### 3. Install the plugin in Nuvio

**In the app:**

1. Open **Settings → Content & Discovery → Plugins**.
2. Choose **Add Repository**.
3. Paste your repository's raw manifest URL, e.g.:
   ```
   https://raw.githubusercontent.com/<user>/<repo>/refs/heads/main/manifest.json
   ```
4. **Refresh** to fetch the provider list.
5. **Enable the "Miruro Anime" provider** (adding the repo alone doesn't turn
   it on). You may also need the global *"Enable plugin providers"* toggle on.

**Via the website (easier for long URLs):**

1. Log in at the Nuvio website → **Account** tab.
2. Select **Plugins** in the sidebar.
3. **Add Plugin / Add Repository**, paste the manifest URL, name it, save.

### 4. Verify

- Open any anime title and open its source list.
- "Miruro …" sources should appear with quality labels next to your other
  addon sources.
- If nothing shows, confirm the provider is enabled and that your Miruro API
  backend is reachable (test its `/episodes/{anilist_id}` with curl).

---

## Local development & testing

For the current Nuvio development workflow:

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
│   └── miruro.js           # Single-file Miruro provider (getStreams)
├── docs/
│   └── API_NOTES.md        # Miruro API endpoints used
├── LICENSE                 # MIT
├── .gitignore
└── README.md
```

---

## Stream object format

The provider returns an array of Nuvio-compatible stream objects:

```javascript
{
  name: "Miruro kiwi-sub 1080p",   // Provider label + quality
  title: "S01E01",                 // Episode descriptor
  url: "https://.../master.m3u8",  // Playable HLS URL
  quality: 1080,
  provider: "miruro",
  format: "m3u8",
  headers: {                       // Required for playback
    Referer: "https://miruro.tv/",
    Origin: "https://miruro.tv",
    "User-Agent": "Mozilla/5.0 ..."
  }
}
```

---

## Miruro API endpoints used

| Purpose | Endpoint |
|---|---|
| Episodes for an anime | `GET /episodes/{anilist_id}` |
| Streaming sources for an episode | `GET /watch/{provider}/{anilistId}/{category}/{slug}` |

See [`docs/API_NOTES.md`](docs/API_NOTES.md) for response shapes and notes.

---

## Disclaimer

This project is for educational and interoperability purposes. It does not
host or distribute any copyrighted content; it only resolves stream URLs from
the Miruro API. Users are responsible for complying with applicable laws and
each source's terms of service. Miruro and Nuvio are trademarks of their
respective owners; this project is independent and not affiliated with or
endorsed by them.
