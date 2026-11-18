"""Decide which marked seats are taken on a fixed camera view, using the people boxes from detect.py.

A seat is one point (where a seated person's body would be). It is taken in one picture when a person's box contains
that point and the box is not tall and thin (a standing person). It counts as taken only if it is taken in every
picture of the set (the same result on 2 frames in a row).

Where the seats come from: the dots saved on the app's calibration page (http://localhost:3000/calibrate.html), read
through the camera key. If the app can't be reached or has none saved, the built-in list below is used instead.
Seat positions are kept as fractions of the picture (0 to 1), so they work for a picture of any size.

Usage:  python seats.py      -> output/seats_<photo>.jpg and output/seats.json
"""
import json
import os

import cv2

import appconfig
import detect

HERE = os.path.dirname(os.path.abspath(__file__))
# Two frames of the same view, a moment apart. The first one is the picture shown in the app.
FRAMES = ["live poc pic 3.jpg", "live seating pic 2.webp"]
# Built-in fallback, marked by eye on a 480 x 270 picture: id, label, anchor (x, y), drawing box (x0, y0, x1, y1)
BASE_W, BASE_H = 480, 270
BUILT_IN = [
    (1, "Table A, seat 1", (150, 140), (122, 110, 186, 205)),
    (2, "Table B, seat 1", (260, 113), (240, 97, 285, 165)),
    (3, "Table B, seat 2", (340, 115), (322, 98, 365, 150)),
    (4, "Back left, seat 1", (13, 92), (3, 74, 25, 108)),
    (5, "Back left, seat 2", (43, 102), (33, 88, 56, 118)),
    (6, "Back left, seat 3", (68, 92), (58, 80, 80, 110)),
    (7, "Back table, seat 1", (205, 108), (190, 95, 220, 125)),
    (8, "Lounge, sofa chair 1", (425, 240), (405, 215, 445, 262)),
    (9, "Lounge, sofa chair 2", (462, 235), (445, 212, 480, 262)),
]
STANDING_RATIO = 2.2  # a box taller than this many times its width is a standing or walking person
OVERLAP_MIN = 0.0  # 0 = a seat is taken only when a person's box contains its dot (the original rule); e.g. 0.3 = also when a person's box covers 30% of the seat's box
MAX_WIDTH = 3000  # pictures wider than this are shrunk before people are looked for (3000 = never: shrinking to 1280 or 1920 changed some seats)
# The drawing box round a seat saved on the calibration page, as fractions of the picture: left, right, above and below the dot
BOX_L, BOX_R, BOX_UP, BOX_DOWN = 0.045, 0.045, 0.10, 0.14


def load_seats():
    """The seats to check: [{id, label, x, y, box, table}], x and y and box as fractions of the picture. table can be None."""
    saved = appconfig.fetch_seats()
    if saved:
        return [{"id": s["id"], "label": f"Seat {s['id']}", "x": s["x"], "y": s["y"], "table": s["table"],
                 "box": (s["x"] - BOX_L, s["y"] - BOX_UP, s["x"] + BOX_R, s["y"] + BOX_DOWN)} for s in saved]
    try:
        by_table = json.load(open(os.path.join(HERE, "camera_map.json")))["tables"]
    except (OSError, ValueError, KeyError):
        by_table = {}
    table_of = {sid: tid for tid, g in by_table.items() for sid in g["seats"]}
    return [{"id": sid, "label": label, "x": a[0] / BASE_W, "y": a[1] / BASE_H, "table": table_of.get(sid),
             "box": (b[0] / BASE_W, b[1] / BASE_H, b[2] / BASE_W, b[3] / BASE_H)} for sid, label, a, b in BUILT_IN]


def seated(person):
    x0, y0, x1, y1 = person["box"]
    return (y1 - y0) / max(1, x1 - x0) <= STANDING_RATIO


def taken_in(people, anchor):
    ax, ay = anchor
    return any(seated(p) and p["box"][0] <= ax <= p["box"][2] and p["box"][1] <= ay <= p["box"][3] for p in people)


def seat_taken(people, seat, w, h):
    """One seat on a w x h picture. With OVERLAP_MIN = 0 this is the old dot test; above 0 a seated person's box must also
    cover at least that share of the seat's drawing box (or contain the dot)."""
    ax, ay = seat["x"] * w, seat["y"] * h
    if taken_in(people, (ax, ay)):
        return True
    if OVERLAP_MIN <= 0:
        return False
    sx0, sy0, sx1, sy1 = seat["box"][0] * w, seat["box"][1] * h, seat["box"][2] * w, seat["box"][3] * h
    area = max(1.0, (sx1 - sx0) * (sy1 - sy0))
    for p in people:
        if not seated(p):
            continue
        px0, py0, px1, py1 = p["box"]
        iw, ih = min(sx1, px1) - max(sx0, px0), min(sy1, py1) - max(sy0, py0)
        if iw > 0 and ih > 0 and iw * ih / area >= OVERLAP_MIN:
            return True
    return False


def analyse(frames=FRAMES, seats=None):
    """Look at each frame and decide every seat. Returns (per_frame, result); a seat is taken only if it is taken in all frames."""
    seats = seats if seats is not None else load_seats()
    net, size = detect.load_model()
    per_frame = []
    for name in frames:
        img = cv2.imread(os.path.join(HERE, "images", name))
        if img.shape[1] > MAX_WIDTH:  # big pictures are shrunk first: the same answer, much faster
            k = MAX_WIDTH / img.shape[1]
            img = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
        h, w = img.shape[:2]
        people = detect.find_people_tiled(net, img, size)
        per_frame.append((name, img, people, [seat_taken(people, s, w, h) for s in seats]))
    result = {"seats": []}
    for k, s in enumerate(seats):
        flags = [f[3][k] for f in per_frame]
        result["seats"].append({**s, "per_frame": flags, "taken": all(flags)})
    return per_frame, result


def draw_marked(frame, result):
    """The frame enlarged to about 1440 wide, with person boxes and every seat marked red (taken) or blue (free)."""
    name, img, people, flags = frame
    k = 1440 / img.shape[1]
    out = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_CUBIC)
    H, W = out.shape[:2]
    for p in people:
        x0, y0, x1, y1 = (int(v * k) for v in p["box"])
        cv2.rectangle(out, (x0, y0), (x1, y1), (60, 200, 60) if seated(p) else (170, 170, 170), 1)
    for s in result["seats"]:
        colour = (40, 40, 230) if s["taken"] else (230, 150, 20)  # taken: red, free: blue (BGR)
        x0, y0, x1, y1 = (int(v) for v in (s["box"][0] * W, s["box"][1] * H, s["box"][2] * W, s["box"][3] * H))
        cv2.rectangle(out, (x0, y0), (x1, y1), colour, 2)
        cv2.circle(out, (int(s["x"] * W), int(s["y"] * H)), 5, colour, -1)
        cv2.putText(out, str(s["id"]), (x0 + 3, y0 + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2, cv2.LINE_AA)
    free = sum(not s["taken"] for s in result["seats"])
    text = f"{len(result['seats'])} seats: {len(result['seats']) - free} taken, {free} free (red = taken, blue = free)"
    cv2.rectangle(out, (0, 0), (out.shape[1], 34), (0, 0, 0), -1)
    cv2.putText(out, text, (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (255, 255, 255), 2, cv2.LINE_AA)
    return out


def main():
    per_frame, result = analyse()
    for frame in per_frame:
        name = frame[0]
        out = draw_marked(frame, result)
        cv2.imwrite(os.path.join(HERE, "output", "seats_" + os.path.splitext(name)[0].replace(" ", "_") + ".jpg"), out, [cv2.IMWRITE_JPEG_QUALITY, 92])
    with open(os.path.join(HERE, "output", "seats.json"), "w") as fh:
        json.dump(result, fh, indent=1)
    for s in result["seats"]:
        print(f"{s['id']} {s['label']:<22} frames {s['per_frame']} -> {'TAKEN' if s['taken'] else 'free'}")


if __name__ == "__main__":
    main()
