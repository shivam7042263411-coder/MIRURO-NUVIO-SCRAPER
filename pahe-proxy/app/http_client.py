import json
import os
import time

import httpx

from . import config
from .bypass import solve_challenge


class PaheHttp:
    """HTTP client that passes animepahe.pw by reusing a solved cf_clearance cookie."""

    def __init__(self):
        self.cookies = self._load_cookies()
        self._client = None

    def _ensure_client(self):
        if self._client is None or self._client.is_closed:
            self._client = httpx.Client(
                headers={"User-Agent": config.UA, "Accept-Language": "en-US,en;q=0.9"},
                timeout=30,
                follow_redirects=True,
            )
            if self.cookies:
                self._client.cookies = _jar(self.cookies)
        return self._client

    def request(self, method, url, **kwargs):
        client = self._ensure_client()
        r = client.request(method, url, **kwargs)

        if _challenged(r):
            time.sleep(1)
            self._fresh_cookies(url)
            client.close()
            self._client = None
            client = self._ensure_client()
            r = client.request(method, url, **kwargs)

        return r

    def get_text(self, url, **kwargs):
        return self.request("GET", url, **kwargs).text

    def get_json(self, url, **kwargs):
        return self.request("GET", url, **kwargs).json()

    def close(self):
        if self._client is not None:
            self._client.close()

    # --- cookie persistence ------------------------------------------------
    def _fresh_cookies(self, url):
        solved = solve_challenge(url)
        if solved:
            self.cookies = solved
            self._save_cookies(solved)

    def _load_cookies(self):
        if not os.path.exists(config.COOKIE_FILE):
            return {}
        try:
            with open(config.COOKIE_FILE) as f:
                return json.load(f)
        except Exception:
            return {}

    def _save_cookies(self, cookies):
        try:
            os.makedirs(os.path.dirname(config.COOKIE_FILE), exist_ok=True)
            with open(config.COOKIE_FILE, "w") as f:
                json.dump(cookies, f)
        except Exception:
            pass


def _challenged(r):
    if r.status_code == 403 and "Just a moment" in r.text[:2000]:
        return True
    return "cf-mitigated: challenge" in str(r.headers.get("server-timing", "")) or \
        r.headers.get("cf-mitigated") == "challenge"


def _jar(cookies):
    jar = httpx.Cookies()
    domain = config.BASE.split("//")[1].split("/")[0]
    for name, value in cookies.items():
        jar.set(name, value, domain=domain, path="/")
    return jar