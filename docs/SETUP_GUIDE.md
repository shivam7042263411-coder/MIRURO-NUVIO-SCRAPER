# Setup Guide

End-to-end instructions for getting the AniDap Anime provider running in Nuvio.

## Prerequisites

- Nuvio **sideloaded** build (app-store builds don't support plugins).
- Internet access to `anidap.lol`, `chad.anidap.lol`, and `api.ani.zip`.
- No backend, no accounts, no extra services — the provider scrapes AniDap
  directly from inside Nuvio.

## Step 1 — Push the repo to GitHub

```bash
git add .
git commit -m "Add AniDap anime provider"
git push origin main
```

## Step 2 — Install the plugin in Nuvio

1. In Nuvio: **Settings → Content & Discovery → Plugins → Add Repository**.
2. Paste the raw manifest URL:
   ```
   https://raw.githubusercontent.com/<user>/<repo>/refs/heads/main/manifest.json
   ```
3. **Refresh**, then **enable the "AniDap Anime" provider**.
4. Make sure **Enable plugin providers globally** is on.

Alternative: add via the Nuvio **Account → Plugins** page on the website.

## Step 3 — Sanity check

- Open a mainstream anime (e.g. Mushoku Tensei) and check its source list.
- Expect entries like `AniDap SUB 720p` and (for TV) `AniDap DUB 720p`.
- If nothing appears, verify network reachability of `anidap.lol` from the
  device and confirm the provider is enabled.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No sources at all | Provider not enabled | Enable it in Plugins settings |
| Repo loads but zero providers | Manifest schema not current | Ensure provider nested under `"scrapers"` |
| Sources only after long delay | AniDap rate limit / slow first fetch | Retry; provider has no caching |
| Specific episode missing | AniDap doesn't carry it | Try another providerId or source site |

## Dev / local testing

```bash
npx serve . -l 3000
```

Then in a **development build** of Nuvio:
**Settings → Developer → Plugin Tester** → enter
`http://<your-ip>:3000/manifest.json` → Fetch → Test.

## Quick endpoint test (from your computer)

```bash
# 1. Map a TMDB id to an AniList id
curl "https://api.ani.zip/mappings?themoviedb_id=112501"

# 2. Get the AniDap slug (use the anilist_id from step 1)
curl -H "Referer: https://anidap.lol/" "https://anidap.lol/api/anime/{anilist_id}"

# 3. Get episode list
curl -H "Referer: https://anidap.lol/" \
  "https://chad.anidap.lol/rest/api/episodes?id={slug}"

# 4. Get direct m3u8 (hard-subbed)
curl -H "Referer: https://anidap.lol/" \
  "https://chad.anidap.lol/rest/api/sources?id={slug}&epNum=1&type=sub&providerId=yuki"
```