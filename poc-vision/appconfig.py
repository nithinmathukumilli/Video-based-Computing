"""Shared settings for the camera scripts: where the app is, the camera key, and the seats saved on the calibration page.

Settings come from the environment first, then from ../.env (the same file the app reads).
"""
import json
import os
import re
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def setting(name, default=""):
    if os.environ.get(name):
        return os.environ[name]
    try:
        for line in open(os.path.join(HERE, "..", ".env"), encoding="utf-8"):
            m = re.match(r"\s*" + name + r"\s*=\s*(.*?)\s*$", line)
            if m and not line.lstrip().startswith("#"):
                return m.group(1).strip("\"'")
    except OSError:
        pass
    return default


def app_url():
    return (setting("APP_URL") or f"http://localhost:{setting('PORT', '3000')}").rstrip("/")


def fetch_seats():
    """The seats saved on the calibration page: [{id, x, y, table}] with x and y between 0 and 1. None if the app can't be reached."""
    key = setting("CAMERA_KEY")
    if not key:
        return None
    req = urllib.request.Request(app_url() + "/api/camera/seats", headers={"X-Camera-Key": key})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r).get("seats", [])
    except (urllib.error.URLError, OSError, ValueError):
        return None
