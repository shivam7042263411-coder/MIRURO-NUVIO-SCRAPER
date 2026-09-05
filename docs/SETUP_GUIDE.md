# Setup Guide

End-to-end instructions for getting the Miruro Anime provider running in Nuvio.

## Prerequisites

- Nuvio **sideloaded** build (app-store builds don't support plugins).
- A machine (or VPS) to run the Miruro API backend.
- Python 3.9+ (if using the reference python backend).

## Step 1 — Run the Miruro API backend

```bash
git clone https://github.com/walterwhite-69/Miruro-API.git
cd Miruro-API
pip install -r requirements.txt
uvicorn api:app --host 0.0.0.0 --port 8000
```

Confirm it's up:

```bash
curl "http://localhost:8000/episodes/20" | head
```

### Reach it from your device

If Nuvio runs on a phone/TV, use your machine's LAN IP, not `localhost`:

```bash
# find your LAN IP
ipconfig getifaddr en0        # macOS
```

Test from the device: `curl http://192.168.1.5:8000/episodes/20`.

> If you self-host behind a reverse proxy with HTTPS, put that full URL in
> `MIRURO_API_BASE` instead.

## Step 2 — Configure the provider's API base

Edit `providers/miruro.js`:

```javascript
var MIRURO_API_BASE = "http://192.168.1.5:8000";
```

For distribution, commit this with your own base URL baked in so users just
install the manifest. (Ports/URLs will differ per install; if you want a
per-user configurable base, keep the default and edit per our dev notes below.)

## Step 3 — Install the plugin in Nuvio

1. Push this repository to GitHub.
2. In Nuvio: **Settings → Content & Discovery → Plugins → Add Repository**.
3. Paste the raw manifest URL:
   ```
   https://raw.githubusercontent.com/<user>/<repo>/refs/heads/main/manifest.json
   ```
4. **Refresh**, then **enable the "Miruro Anime" provider**.
5. Make sure **Enable plugin providers globally** is on.

Alternative: add via the Nuvio **Account → Plugins** page on the website.

## Step 4 — Sanity check

- Open a mainstream anime (most providers carry it) and check its source list.
- Expect entries like `Miruro kiwi-sub 1080p`.
- If none appear, hit your backend's `/episodes/{anilist_id}` and
  `/watch/...` routes directly to isolate backend vs. Nuvio issues.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No sources, network 403 | Miruro API on a datacenter IP | Host on clean VPS / local machine |
| No sources, no backend logs | `MIRURO_API_BASE` unreachable from device | Use LAN IP, not `localhost`; test with curl |
| Provider not listed after refresh | Provider not enabled | Enable it in Plugins settings |
| Repo loads but zero providers | Manifest schema not current | Ensure provider nested under `"scrapers"` |

## Dev / local testing

```bash
npx serve . -l 3000
```

Then in a **development build** of Nuvio:
**Settings → Developer → Plugin Tester** → enter
`http://<your-ip>:3000/manifest.json` → Fetch → Test.
