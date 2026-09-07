import os

BASE = os.environ.get("PAHE_BASE", "https://animepahe.pw")
UA = os.environ.get(
    "PAHE_UA",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
)
KWIK_REFERER = os.environ.get("KWIK_REFERER", "https://kwik.cx/")
DATA_DIR = os.environ.get("DATA_DIR", "/data")
COOKIE_FILE = os.path.join(DATA_DIR, "pahe_cookies.json")

CHALLENGE_WAIT = int(os.environ.get("CHALLENGE_WAIT", "45"))
PORT = int(os.environ.get("PORT", "7860"))