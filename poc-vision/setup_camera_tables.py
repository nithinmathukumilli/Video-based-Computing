"""One-time setup: add a "Camera view" part with one app table for each group of camera seats, and save camera_map.json.

camera_map.json says which app table each camera seat belongs to (seat ids are the numbers drawn by seats.py).
Needs the POC app running (default http://localhost:3000, signed in as the local admin). Safe to run twice: it stops if camera_map.json exists.

Usage:  python setup_camera_tables.py [app address]
"""
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
APP = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000").rstrip("/")
MAP_FILE = os.path.join(HERE, "camera_map.json")
# name, shape, camera seat ids, place on the page (x %, y %)
GROUPS = [
    ("Table A", "single", [1], (36, 68)),
    ("Table B", "square", [2, 3], (64, 46)),
    ("Table C", "long", [4, 5, 6], (20, 26)),
    ("Table D", "single", [7], (42, 28)),
    ("Table E", "booth", [8, 9], (82, 84)),
]


def post(path, body):
    req = urllib.request.Request(APP + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def main():
    if os.path.exists(MAP_FILE):
        sys.exit("camera_map.json already exists, so the tables are already set up. Delete it (and the 'Camera view' part in the app) to start again.")
    before = {t["id"] for t in json.load(urllib.request.urlopen(APP + "/api/state"))["tables"]}
    parts_before = {p["id"] for p in json.load(urllib.request.urlopen(APP + "/api/state"))["parts"]}
    state = post("/api/admin/parts", {"name": "Camera view"})
    part = next(p["id"] for p in state["parts"] if p["id"] not in parts_before)
    mapping = {}
    for name, shape, seats, _ in GROUPS:
        state = post("/api/admin/tables", {"name": name, "cap": len(seats), "shape": shape, "part": part})
        new = [t for t in state["tables"] if t["id"] not in before and t["name"] == name][-1]
        before.add(new["id"])
        mapping[new["id"]] = {"name": name, "seats": seats}
    post("/api/admin/layout", {"tables": [{"id": tid, "x": g[3][0], "y": g[3][1]} for tid, g in zip(mapping, GROUPS)]})
    with open(MAP_FILE, "w") as fh:
        json.dump({"part": part, "tables": mapping}, fh, indent=1)
    print(f"Created part {part} 'Camera view' with {len(mapping)} tables: " + ", ".join(f"{v['name']}={k}" for k, v in mapping.items()))


if __name__ == "__main__":
    main()
