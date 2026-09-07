import re
import urllib.parse

from . import config
from .http_client import PaheHttp


def search(query, page=1):
    client = PaheHttp()
    url = f"{config.BASE}/api?m=search&q={urllib.parse.quote(query)}&page={page}"
    data = client.get_json(url)
    results = []
    for item in data.get("data", []):
        results.append(
            {
                "title": item.get("title"),
                "year": item.get("year"),
                "id": item.get("id"),
                "type": item.get("type"),
                "status": item.get("status"),
                "episodes": item.get("episodes"),
                "score": item.get("score"),
                "poster": item.get("poster"),
                "session": item.get("session"),
            }
        )
    return {
        "query": query,
        "total": data.get("total"),
        "per_page": data.get("per_page"),
        "current_page": data.get("current_page"),
        "results": results,
    }


def get_anime_id(anime_id):
    """Return a stable id for release-list lookups (search returns numeric id)."""
    return str(anime_id)


def episodes(anime_id, page=1):
    client = PaheHttp()
    url = f"{config.BASE}/api?m=release&id={urllib.parse.quote(anime_id)}&sort=episode_asc&page={page}"
    data = client.get_json(url)
    out = []
    for item in data.get("data", []):
        out.append(
            {
                "episode": item.get("episode"),
                "session": item.get("session"),
                "title": item.get("title"),
                "duration": item.get("duration"),
                "snapshot": item.get("snapshot"),
                "fansub": item.get("fansub"),
            }
        )
    return {
        "anime_id": anime_id,
        "total": data.get("total"),
        "next_url": data.get("next_page_url"),
        "episodes": out,
    }


def episode_session(anime_id, ep_num):
    """Resolve an episode number to its pahe session id (fetches release list)."""
    page = 1
    while True:
        ep_list = episodes(anime_id, page=page)
        for ep in ep_list["episodes"]:
            if str(ep["episode"]) == str(ep_num):
                return ep
        if not ep_list.get("next_url"):
            break
        page += 1
    return None


def play_page(anime_id, session):
    """Fetch the play page and extract the kwik stream iframe URL."""
    client = PaheHttp()
    url = f"{config.BASE}/play/{urllib.parse.quote(str(anime_id))}/{urllib.parse.quote(str(session))}"
    html = client.get_text(url)
    iframe = _find_kwik(html)
    return {"url": url, "iframe": iframe, "html_bytes": len(html)}


def _find_kwik(html):
    patterns = [
        r'data-src=["\'](https?://(?:kwik\.cx|kwik\.si)/e/[^"\']+)["\']',
        r'data-src=["\']([^"\']*(?:kwik\.cx|kwik\.si)[^"\']*)["\']',
        r'<iframe[^>]*src=["\'](https?://(?:kwik\.cx|kwik\.si)/[^"\']+)["\']',
    ]
    for pat in patterns:
        m = re.search(pat, html)
        if m:
            return m.group(1)
    return None