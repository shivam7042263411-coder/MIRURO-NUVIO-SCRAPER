# animepahe middleman

Middleman API + proxied HLS that lets Nuvio (or any player) consume
[AnimePahe](https://animepahe.pw) streams without hitting Cloudflare directly
or worrying about Referer locks.

It is designed to run as a **Hugging Face Docker Space** (port 7860). The only
tricky requirement: this server is the same machine that talks to animepahe.pw,
so the `cf_clearance` cookie stays valid (it is IP-bound).

## Deploy on Hugging Face

1. Create a free account at huggingface.co and grab an access token
   (Settings -> Access Tokens -> New token: write).
2. New Space -> name it -> **SDK: Docker** -> "Blank" template.
3. Upload the whole `pahe-proxy` folder (all `app/` files, `requirements.txt`,
   `Dockerfile`) using the **Files** tab (drag & drop) or the `hf` CLI.
4. The Space builds the Docker image and boots on `.hf.space`.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /api/health` | status + challenge stats |
| `GET /api/search?q=attack+on+titan` | pahe search |
| `GET /api/episodes?id=<anime_id>` | episode list (pahe release ids) |
| `GET /api/stream?id=<anime_id>&ep=<epnum\|session>` | resolve episode, returns proxied master URL |
| `GET /hls/<token>/master.m3u8` | proxied HLS master (player loads this) |
| `GET /hls/<token>/p?u=<b64url>` | proxied media asset (internal) |

### Quick usage

```bash
curl "https://<your-space>.hf.space/api/search?q=attack+on+titan"
curl "https://<your-space>.hf.space/api/episodes?id=<anime_id>&page=1"
# -> grab an episode number + anime id, then:
curl "https://<your-space>.hf.space/api/stream?id=<anime_id>&ep=1"
# -> returns { "url": "/hls/<token>/master.m3u8" }
# load "https://<your-space>.hf.space/hls/<token>/master.m3u8" in the player
```

## Env vars (optional)

Set in the Space settings:

- `PAHE_BASE` (default `https://animepahe.pw`)
- `PAHE_UA`
- `COOKIE_FILE` / `DATA_DIR` (default `/data/pahe_cookies.json`)
- `CHALLENGE_WAIT` (default `45`)

**Persistent storage:** if the Space offers persistent storage, enable and
mount it at `/data` so the solved `cf_clearance` survives restarts (it only
helps if the Space's outbound IP is unchanged).

## Notes / caveats

- First call on a cold Space pays a one-time ~10-45s Cloudflare solve.
- datacenter-IP risk: if animepahe.pw decides to show an *interactive*
  Cloudflare challenge to Cloud-vm IPs, playback cannot be automated.
- The proxy fetches every segment through the Space (extra bandwidth on free
  tier, but keeps Referer/UA/IP consistent).