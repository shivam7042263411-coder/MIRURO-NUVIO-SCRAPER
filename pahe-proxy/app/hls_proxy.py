import base64
import re
import threading
import time
import urllib.parse

import httpx

from . import config


class TokenStore:
    """In-memory registry mapping short tokens to resolved stream URLs."""

    def __init__(self, ttl_hours=6):
        self._data = {}
        self._lock = threading.Lock()
        self.ttl = ttl_hours * 3600

    def put(self, token, master_url, referer):
        base = master_url.rsplit("/", 1)[0] + "/"
        with self._lock:
            self._data[token] = {
                "master": master_url,
                "base": base,
                "referer": referer,
                "expires": time.time() + self.ttl,
            }

    def get(self, token):
        with self._lock:
            rec = self._data.get(token)
            if not rec:
                return None
            if rec["expires"] < time.time():
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
    headers = {
        "User-Agent": config.UA,
        "Referer": referer,
        "Accept": "*/*",
    }
    with httpx.Client(headers=headers, timeout=60, follow_redirects=True) as client:
        with client.stream("GET", absurl) as resp:
            resp.raise_for_status()
            for chunk in resp.iter_bytes():
                yield chunk