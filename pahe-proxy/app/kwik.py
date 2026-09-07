from playwright.sync_api import sync_playwright

from . import config
from . import counters


def resolve_kwik(kwik_url, referer=None):
    """Load the kwik embed in Chromium and capture the m3u8 it requests."""
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
            ],
        )
        try:
            context = browser.new_context(user_agent=config.UA, locale="en-US")
            page = context.new_page()
            counters.bump("kwik_view_attempts")

            found = []
            page.on("response", lambda r: _collect_m3u8(r, found))

            try:
                page.goto(kwik_url, referer=referer, wait_until="domcontentloaded", timeout=45000)
            except Exception:
                pass

            # kwik preloads/ad-vault then fires the m3u8; poll then retry reload.
            for _ in range(25):
                if found:
                    break
                try:
                    page.wait_for_timeout(2000)
                except Exception:
                    break
                if _ > 10 and not found:
                    try:
                        page.reload(wait_until="domcontentloaded")
                    except Exception:
                        pass

            url = found[-1] if found else None
            counters.set("kwik_last_m3u8", "yes" if url else "no")
            return url
        finally:
            try:
                browser.close()
            except Exception:
                pass


def _collect_m3u8(response, found):
    try:
        rurl = response.url
        if ".m3u8" in rurl:
            if rurl not in found:
                found.append(rurl)
    except Exception:
        pass