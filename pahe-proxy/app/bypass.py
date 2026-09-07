import time

from playwright.sync_api import sync_playwright

from . import config
from . import counters


def solve_challenge(url, wait=config.CHALLENGE_WAIT):
    """Open the page in headless Chromium, wait for Cloudflare's JS challenge to
    auto-clear, then return the browser cookies as {name: value} plus UA."""
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
            counters.bump("playwright_launches")

            challenge_seen = False
            deadline = time.time() + wait
            while time.time() < deadline:
                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=30000)
                    break
                except Exception:
                    time.sleep(2)

            # Poll for the clearance cookie; the challenge runs JS that sets it.
            while time.time() < deadline:
                cookies = context.cookies()
                names = {c["name"] for c in cookies}
                if "cf_clearance" in names:
                    challenge_seen = True
                    break
                time.sleep(2)

            # Give the page an extra beat so any API/lazy loads complete.
            try:
                page.wait_for_timeout(3000)
            except Exception:
                pass

            ua = page.evaluate("navigator.userAgent")
            out = {c["name"]: c["value"] for c in context.cookies()}
            counters.set("challenge_passed", challenge_seen)
            return out if out else None
        finally:
            try:
                browser.close()
            except Exception:
                pass