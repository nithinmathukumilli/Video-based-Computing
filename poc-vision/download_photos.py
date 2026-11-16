"""Download the chosen photos from candidates.json and write their credits.

Usage:  python download_photos.py 3 10 23 4 26     (the numbers printed by find_photos.py)
"""
import json
import os
import sys
import time
import urllib.request

UA = "canteen-poc/0.1 (internal demo of a seat-availability app)"


def main(picks):
    with open("candidates.json", encoding="utf-8") as f:
        cands = json.load(f)
    os.makedirs("images", exist_ok=True)
    credits = ["# Photo credits", "",
               "These photos come from Wikimedia Commons and are used under the licences shown. Keep this file with the photos.",
               "Where a licence is CC BY or CC BY-SA, the author must be credited; CC BY-SA also asks that changed copies",
               "(for example the pictures with boxes drawn on them) are shared under the same licence.", ""]
    for n, idx in enumerate(picks, start=1):
        c = cands[idx]
        path = os.path.join("images", f"photo{n}.jpg")
        req = urllib.request.Request(c["thumb"], headers={"User-Agent": UA})
        for attempt in range(4):  # Wikimedia asks clients to slow down if they go too fast
            try:
                with urllib.request.urlopen(req, timeout=60) as r, open(path, "wb") as out:
                    out.write(r.read())
                break
            except Exception as e:  # noqa: BLE001
                print(f"  photo{n}: attempt {attempt + 1} failed ({e})")
                time.sleep(3 * (attempt + 1))
        else:
            print(f"photo{n}: giving up on {c['title']}")
            continue
        size = os.path.getsize(path) // 1024
        print(f"photo{n}.jpg  {size} KB  {c['licence']:<13} {c['title']}")
        credits += [
            f"## photo{n}.jpg",
            f"- Title: {c['title'].replace('File:', '')}",
            f"- Author: {c['author'] or 'see the source page'}",
            f"- Licence: {c['licence']}" + (f" ({c['licence_url']})" if c["licence_url"] else ""),
            f"- Source: {c['page']}",
            "",
        ]
        time.sleep(1.5)
    with open(os.path.join("images", "CREDITS.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(credits))
    print("credits written to images/CREDITS.md")


if __name__ == "__main__":
    main([int(x) for x in sys.argv[1:]])
