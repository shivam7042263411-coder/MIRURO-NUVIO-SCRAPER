import base64

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse

from . import config
from . import counters
from . import hls_proxy
from . import kwik
from . import pahe

app = FastAPI(title="animepahe middleman", version="0.1.0")


@app.get("/")
def index():
    return {
        "service": "animepahe middleman",
        "version": "0.1.0",
        "endpoints": ["/api/health", "/api/search", "/api/episodes", "/api/stream", "/hls/{token}/master.m3u8"],
        "base": config.BASE,
        "stats": counters.snapshot(),
    }


@app.get("/api/health")
def health():
    return JSONResponse(
        {
            "ok": True,
            "stats": counters.snapshot(),
            "note": "challenge_passed=true means we hold a cf_clearance",
        }
    )


@app.get("/api/search")
def api_search(q: str, page: int = 1):
    if not q:
        raise HTTPException(400, "missing q")
    return pahe.search(q, page)


@app.get("/api/episodes")
def api_episodes(id: str, page: int = 1):
    return pahe.episodes(id, page)


@app.get("/api/stream")
def api_stream(id: str, ep: str):
    """Resolve one episode to a proxied HLS master.

    ep may be an episode number (resolved via release list) or a pahe session id.
    """
    ep_num = None
    session = ep
    if not re_is_session(ep):
        found = pahe.episode_session(id, ep)
        if not found:
            raise HTTPException(404, f"episode {ep} not found for anime {id}")
        ep_num = found["episode"]
        session = found["session"]

    play = pahe.play_page(id, session)
    if not play["iframe"]:
        raise HTTPException(502, "no kwik iframe on play page")

    master = kwik.resolve_kwik(play["iframe"], referer=play["url"])
    if not master:
        raise HTTPException(502, "could not resolve m3u8 from kwik")

    token = hls_proxy.make_token(master, config.KWIK_REFERER)
    return {
        "anime_id": id,
        "episode": ep_num if ep_num is not None else ep,
        "source": "animepahe",
        "iframe": play["iframe"],
        "master": master,
        "url": f"/hls/{token}/master.m3u8",
    }


@app.get("/hls/{token}/master.m3u8")
def master_playlist(token: str, request: Request):
    rec = hls_proxy.tokens.get(token)
    if not rec:
        raise HTTPException(404, "token expired or unknown")

    text = _fetch_text(rec["master"], rec["referer"])
    host = f"https://{request.headers.get('host') or ''}"
    body = hls_proxy.rewrite_playlist(text, token, host, rec["base"])
    return PlainTextResponse(
        body,
        media_type="application/vnd.apple.mpegurl",
        headers={"Access-Control-Allow-Origin": "*"},
    )


@app.get("/hls/{token}/p")
def proxy_asset(token: str, u: str, request: Request):
    rec = hls_proxy.tokens.get(token)
    if not rec:
        raise HTTPException(404, "token expired or unknown")
    try:
        absurl = base64.urlsafe_b64decode(u).decode()
    except Exception:
        raise HTTPException(400, "bad url")
    return StreamingResponse(
        hls_proxy.fetch_proxied(absurl, rec["referer"]),
        media_type="application/octet-stream",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=300",
        },
    )


def _fetch_text(url, referer):
    import httpx

    with httpx.Client(
        headers={"User-Agent": config.UA, "Referer": referer, "Accept": "*/*"},
        timeout=30,
        follow_redirects=True,
    ) as client:
        r = client.get(url)
        r.raise_for_status()
        return r.text


def re_is_session(s):
    import re

    return re.fullmatch(r"[A-Za-z0-9_\-]{8,}", s) is not None