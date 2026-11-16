"""Find openly licensed photos of people eating in cafeterias, using the Wikimedia Commons API.

Only photos with a free licence are kept (public domain, CC0, CC BY, CC BY-SA). The licence, the author and the
page each photo came from are saved next to it, because most of these licences require crediting the author.

Usage:  python find_photos.py            -> prints candidates and saves candidates.json
"""
import json
import re
import urllib.parse
import urllib.request

API = "https://commons.wikimedia.org/w/api.php"
UA = "canteen-poc/0.1 (internal demo of a seat-availability app)"
SEARCHES = [
    "cafeteria people eating lunch",
    "canteen interior students eating",
    "dining hall people eating",
    "staff canteen lunch tables",
    "food court people eating tables",
    "restaurant interior people dining",
]
# licence short names we accept
OK = re.compile(r"^(CC0|Public domain|PD|CC BY(-SA)? [0-9.]+)", re.I)


def call(params):
    url = API + "?" + urllib.parse.urlencode({**params, "format": "json"})
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def strip_html(s):
    return re.sub(r"<[^>]+>", "", s or "").strip()


def main():
    seen, out = set(), []
    for term in SEARCHES:
        data = call({
            "action": "query", "generator": "search", "gsrnamespace": 6, "gsrsearch": f"{term} filetype:bitmap",
            "gsrlimit": 25, "prop": "imageinfo", "iiprop": "url|size|mime|extmetadata", "iiurlwidth": 1280,
        })
        for page in (data.get("query", {}).get("pages", {}) or {}).values():
            info = (page.get("imageinfo") or [{}])[0]
            meta = info.get("extmetadata", {})
            lic = (meta.get("LicenseShortName", {}) or {}).get("value", "")
            title = page.get("title", "")
            if title in seen or info.get("mime") != "image/jpeg" or not OK.match(lic):
                continue
            if info.get("width", 0) < 1200:
                continue
            seen.add(title)
            out.append({
                "title": title,
                "licence": lic,
                "licence_url": (meta.get("LicenseUrl", {}) or {}).get("value", ""),
                "author": strip_html((meta.get("Artist", {}) or {}).get("value", "")),
                "description": strip_html((meta.get("ImageDescription", {}) or {}).get("value", ""))[:160],
                "page": "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_")),
                "thumb": info.get("thumburl") or info.get("url"),
                "width": info.get("width"),
                "height": info.get("height"),
                "found_by": term,
            })
    with open("candidates.json", "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    for i, c in enumerate(out):
        print(f"{i:2d}  {c['licence']:<14} {c['width']}x{c['height']}  {c['title'][:70]}  | {c['description'][:70]}")
    print(f"\n{len(out)} candidates saved to candidates.json")


if __name__ == "__main__":
    main()
