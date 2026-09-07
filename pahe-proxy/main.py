"""
AnimePahe Proxy Server for Nuvio (Termux / Docker / Local)
Run: python main.py
Endpoints:
  GET /api/search?q=...
  GET /api/episodes?id=<anime_session>
  GET /api/stream?id=<anime_id>&ep=<episode_or_session>
  GET /hls/<token>/master.m3u8
  GET /hls/<token>/p?u=<b64url>
"""

import base64
import re
import threading
import time
import urllib.parse
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse, StreamingResponse
from playwright.sync_api import sync_playwright

app = FastAPI(title="AnimePahe Proxy", version="1.0.0")

# ─── Config ───
PAHE_BASE = "https://animepahe.pw"
KWIK_REFERER = "https://kwik.cx/"
PAHE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

# ─── Cookie handling ───
_COOKIE_STORE = {"cookie": "", "ua": "", "expires": 0}
_COOKIE_LOCK = threading.Lock()

def set_cookie(cookie: str, ua: str, ttl_hours: int = 6):
    with _COOKIE_LOCK:
        _COOKIE_STORE.update({
            "cookie": cookie,
            "ua": ua,
            "expires": time.time() + ttl_hours * 3600
        })

def get_cookie():
    with _COOKIE_LOCK:
        if _COOKIE_STORE["expires"] < time.time():
            return "", ""
        return _COOKIE_STORE["cookie"], _COOKIE_STORE["ua"]

# ─── HTTP Client ───
class PaheClient:
    def __init__(self):
        self._client = None

    def _client_get(self):
        cookie, ua = get_cookie()
        headers = {
            "User-Agent": ua or PAHE_UA,
            "Referer": PAHE_BASE + "/",
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9"
        }
        if cookie:
            headers["Cookie"] = cookie
        if self._client is None or self._client.is_closed:
            self._client = httpx.Client(headers=headers, timeout=30, follow_redirects=True)
        else:
            self._client.headers.update(headers)
        return self._client

    def request(self, method, url, **kwargs):
        client = self._client_get()
        r = client.request(method, url, **kwargs)
        if r.status_code == 403 and "Just a moment" in r.text[:500]:
            # Trigger cookie refresh
            solve_challenge()
            cookie, ua = get_cookie()
            if cookie:
                client.headers["Cookie"] = cookie
                client.headers["User-Agent"] = ua
                r = client.request(method, url, **kwargs)
        return r

    def get_json(self, url, **kwargs):
        return self.request("GET", url, **kwargs).json()

    def get_text(self, url, **kwargs):
        return self.request("GET", url, **kwargs).text

    def close(self):
        if self._client:
            self._client.close()

pahe_client = PaheClient()

# ─── Cloudflare Challenge Solver ───
def solve_challenge():
    """Launch Playwright, solve CF challenge, store cookie."""
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"]
            )
            context = browser.new_context(user_agent=PAHE_UA, locale="en-US")
            page = context.new_page()
            page.goto(PAHE_BASE, wait_until="domcontentloaded", timeout=60000)
            # Wait for challenge to clear
            deadline = time.time() + 45
            while time.time() < deadline:
                cookies = context.cookies()
                if any(c["name"] == "cf_clearance" for c in cookies):
                    break
                time.sleep(2)
            page.wait_for_timeout(3000)
            ua = page.evaluate("navigator.userAgent")
            cookies = {c["name"]: c["value"] for c in context.cookies()}
            cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())
            browser.close()
            set_cookie(cookie_str, ua)
            print(f"[CF] Challenge solved, cookie stored")
    except Exception as e:
        print(f"[CF] Challenge failed: {e}")

# ─── Token Store for HLS Proxy ───
class TokenStore:
    def __init__(self, ttl_hours=6):
        self._data = {}
        self._lock = threading.Lock()
        self.ttl = ttl_hours * 3600

    def put(self, token, master_url, referer):
        base = master_url.rsplit("/", 1)[0] + "/"
        with self._lock:
            self._data[token] = {"master": master_url, "base": base, "referer": referer, "expires": time.time() + self.ttl}

    def get(self, token):
        with self._lock:
            rec = self._data.get(token)
            if not rec or rec["expires"] < time.time():
                self._data.pop(token, None)
                return None
            return rec

tokens = TokenStore()

RE_KEY_MAP = re.compile(r'URI="([^"]+)"')

def make_token(master_url, referer):
    tok = base64.urlsafe_b64encode(urllib.parse.quote(master_url, safe="").encode())[:18].decode().rstrip("=")
    tokens.put(tok, master_url, referer)
    return tok

def rewrite_playlist(text, token, host, base):
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            out.append("")
            continue
        if line.startswith("#EXT-X-KEY") or line.startswith("#EXT-X-MAP") or line.startswith("#EXT-X-SESSION-KEY"):
            m = RE_KEY_MAP.search(line)
            if m:
                absurl = urllib.parse.urljoin(base, m.group(1))
                line = line[:m.start(1)] + proxy_url(token, host, absurl) + line[m.end(1):]
            out.append(line)
        elif not line.startswith("#"):
            absurl = urllib.parse.urljoin(base, line)
            out.append(proxy_url(token, host, absurl))
        else:
            out.append(line)
    return "\n".join(out)

def proxy_url(token, host, absurl):
    b64 = base64.urlsafe_b64encode(absurl.encode()).decode()
    return f"{host}/hls/{token}/p?u={b64}"

def fetch_proxied(absurl, referer):
    headers = {"User-Agent": PAHE_UA, "Referer": referer, "Accept": "*/*"}
    with httpx.Client(headers=headers, timeout=60, follow_redirects=True) as client:
        with client.stream("GET", absurl) as resp:
            resp.raise_for_status()
            for chunk in resp.iter_bytes():
                yield chunk

# ─── Pahe API Functions ───
def pahe_search(query: str, page: int = 1):
    url = f"{PAHE_BASE}/api?m=search&q={urllib.parse.quote(query)}&page={page}"
    return pahe_client.get_json(url)

def pahe_episodes(anime_session: str, page: int = 1):
    url = f"{PAHE_BASE}/api?m=release&id={urllib.parse.quote(anime_session)}&sort=episode_asc&page={page}"
    return pahe_client.get_json(url)

def pahe_episode_session(anime_session: str, wanted_ep: int, page: int = 1):
    data = pahe_episodes(anime_session, page)
    for ep in data.get("data", []):
        if str(ep.get("episode")) == str(wanted_ep):
            return ep
    next_url = data.get("next_page_url")
    if next_url:
        return pahe_episode_session(anime_session, wanted_ep, page + 1)
    return None

def pahe_play_page(anime_id: str, session: str):
    url = f"{PAHE_BASE}/play/{urllib.parse.quote(str(anime_id))}/{urllib.parse.quote(str(session))}"
    headers = {"Referer": f"{PAHE_BASE}/anime/{urllib.parse.quote(str(anime_id))}"}
    html = pahe_client.get_text(url, headers=headers)
    return {"html": html, "url": url}

def find_kwik(html: str) -> str:
    patterns = [
        r'data-src=["\'](https?://(?:kwik\.cx|kwik\.si)/e/[^"\']+)["\']',
        r'<iframe[^>]*src=["\'](https?://(?:kwik\.cx|kwik\.si)/[^"\']+)["\']',
        r'data-src=["\']([^"\']*(?:kwik\.cx|kwik\.si)[^"\']*)["\']'
    ]
    for pat in patterns:
        m = re.search(pat, html)
        if m:
            return m.group(1)
    return ""

def resolve_kwik(kwik_url: str, referer: str) -> Optional[str]:
    headers = {
        "User-Agent": PAHE_UA,
        "Referer": referer,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9"
    }
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"]
            )
            context = browser.new_context(user_agent=PAHE_UA, locale="en-US")
            page = context.new_page()
            found = []
            page.on("response", lambda r: found.append(r.url) if ".m3u8" in r.url else None)
            page.goto(kwik_url, referer=referer, wait_until="domcontentloaded", timeout=60000)
            for _ in range(30):
                if found:
                    break
                page.wait_for_timeout(2000)
                if _ > 15:
                    try:
                        page.reload(wait_until="domcontentloaded")
                    except:
                        pass
            url = found[-1] if found else None
            browser.close()
            return url
    except Exception as e:
        print(f"[Kwik] Playwright resolve failed: {e}")
    return None

# ─── FastAPI Routes ───
@app.get("/")
def index():
    return {
        "service": "AnimePahe Proxy",
        "endpoints": [
            "GET /api/search?q=",
            "GET /api/episodes?id=<anime_session>",
            "GET /api/stream?id=<anime_id>&ep=<ep>",
            "GET /hls/<token>/master.m3u8",
            "GET /hls/<token>/p?u=<b64url>"
        ],
        "cookie_set": bool(get_cookie()[0])
    }

@app.get("/api/health")
def health():
    cookie, _ = get_cookie()
    return {"ok": True, "cookie_valid": bool(cookie)}

@app.get("/api/search")
def api_search(q: str, page: int = 1):
    return pahe_search(q, page)

@app.get("/api/episodes")
def api_episodes(id: str, page: int = 1):
    return pahe_episodes(id, page)

@app.get("/api/stream")
def api_stream(id: str, ep: str):
    ep_num = None
    session = ep
    if not re.fullmatch(r"[A-Za-z0-9_\-]{8,}", ep):
        found = pahe_episode_session(id, ep)
        if not found:
            raise HTTPException(404, "Episode not found")
        ep_num = found["episode"]
        session = found["session"]

    play = pahe_play_page(id, session)
    kwik = find_kwik(play["html"])
    if not kwik:
        kwik = f"https://kwik.cx/e/{urllib.parse.quote(session)}"

    master = resolve_kwik(kwik, play["url"])
    if not master:
        raise HTTPException(502, "Could not resolve m3u8")

    token = make_token(master, KWIK_REFERER)
    return {
        "anime_id": id,
        "episode": ep_num or ep,
        "source": "animepahe",
        "iframe": kwik,
        "master": master,
        "url": f"/hls/{token}/master.m3u8"
    }

@app.get("/hls/{token}/master.m3u8")
def master_playlist(token: str, request: Request):
    rec = tokens.get(token)
    if not rec:
        raise HTTPException(404, "Token expired or unknown")
    headers = {"User-Agent": PAHE_UA, "Referer": rec["referer"], "Accept": "*/*"}
    with httpx.Client(headers=headers, timeout=30, follow_redirects=True) as client:
        r = client.get(rec["master"])
        r.raise_for_status()
    host = f"https://{request.headers.get('host')}"
    body = rewrite_playlist(r.text, token, host, rec["base"])
    return PlainTextResponse(
        body,
        media_type="application/vnd.apple.mpegurl",
        headers={"Access-Control-Allow-Origin": "*"}
    )

@app.get("/hls/{token}/p")
def proxy_asset(token: str, u: str, request: Request):
    rec = tokens.get(token)
    if not rec:
        raise HTTPException(404, "Token expired or unknown")
    try:
        absurl = base64.urlsafe_b64decode(u).decode()
    except:
        raise HTTPException(400, "Bad url")
    return StreamingResponse(
        fetch_proxied(absurl, rec["referer"]),
        media_type="application/octet-stream",
        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300"}
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=7860)