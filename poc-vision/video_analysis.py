"""Replay a video as if it were live and log which seats are taken.

Every --every seconds of video time (default 3) one frame is taken, the people in it are found (YOLOX-S, as in detect.py)
and each marked seat is decided with the same rule as seats.py. A seat only changes state after a few samples in a row
agree (ON_SAMPLES to become taken, OFF_SAMPLES to become free), so a person leaning over or walking past does not flicker.

Writes to poc-vision/reports/ (not committed: it comes from video of people):
  occupancy_<video>_<time>.csv   one row per sample: time, people found, taken seats, and each seat (1 = taken)
  summary_<video>_<time>.txt     occupancy over the video, peak, how long each seat was used, and every change
  marked_<video>_<time>_first.jpg and _last.jpg   the first and last sample with every seat marked red (taken) or blue (free)

Seats: the dots saved on the app's calibration page (the app must be running, and CAMERA_KEY set in .env), or a JSON file
given with --seats-file:  [{"id": 1, "x": 0.53, "y": 0.60, "table": "t5"}, ...]   x and y are fractions of the picture,
table is optional. There is no built-in fallback here: seats marked for a different picture would give wrong answers.

Usage:  python video_analysis.py                          newest video in videos/, as fast as possible
        python video_analysis.py --realtime               the video's own pace: a 1-hour video takes 1 hour
        python video_analysis.py --every 2 --post         also send the seat counts to the app after every sample
        python video_analysis.py --video clip.mp4 --seats-file seats_clip.json --loops 4
"""
import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

import cv2

import appconfig
import detect
import seats

HERE = os.path.dirname(os.path.abspath(__file__))
VIDEOS = os.path.join(HERE, "videos")
REPORTS = os.path.join(HERE, "reports")
EXTENSIONS = (".mp4", ".mov", ".avi", ".mkv", ".webm")
ON_SAMPLES = 2  # samples in a row that must show a person before a seat counts as taken
OFF_SAMPLES = 3  # samples in a row that must show nobody before a seat counts as free


class SeatState:
    """A seat's decided state, which changes only after enough samples in a row disagree with it."""

    def __init__(self):
        self.taken = None
        self.run = 0

    def update(self, raw):
        """Feed one sample. Returns True if the decided state changed."""
        if self.taken is None:  # the first sample is taken as it is
            self.taken, self.run = raw, 0
            return False
        if raw == self.taken:
            self.run = 0
            return False
        self.run += 1
        if self.run >= (ON_SAMPLES if raw else OFF_SAMPLES):
            self.taken, self.run = raw, 0
            return True
        return False


def find_video(name):
    if name:
        path = name if os.path.isabs(name) or os.path.exists(name) else os.path.join(VIDEOS, name)
        if not os.path.exists(path):
            sys.exit(f"Video not found: {name}")
        return path
    found = [f for f in os.listdir(VIDEOS) if f.lower().endswith(EXTENSIONS)] if os.path.isdir(VIDEOS) else []
    if not found:
        sys.exit(f"No video found. Put one in {VIDEOS} or pass --video.")
    return os.path.join(VIDEOS, max(found, key=lambda f: os.path.getmtime(os.path.join(VIDEOS, f))))


def load_video_seats(seats_file):
    if seats_file:
        with open(seats_file, encoding="utf-8") as fh:
            saved = json.load(fh)
    else:
        saved = appconfig.fetch_seats()
        if not saved:
            sys.exit("No seats found. Start the app (restart-canteen.bat), set CAMERA_KEY in .env and mark the seats on "
                     "/calibrate.html, or pass --seats-file.")
    return [{"id": s["id"], "label": f"Seat {s['id']}", "x": s["x"], "y": s["y"], "table": s.get("table"),
             "box": (s["x"] - seats.BOX_L, s["y"] - seats.BOX_UP, s["x"] + seats.BOX_R, s["y"] + seats.BOX_DOWN)} for s in saved]


def post_counts(seat_list, states):
    """Send 'table X: n seats taken' to the app, like post_camera.py. A failure is printed, never fatal."""
    by_table = {}
    for s, st in zip(seat_list, states):
        if s["table"]:
            by_table[s["table"]] = by_table.get(s["table"], 0) + int(st.taken)
    key = appconfig.setting("CAMERA_KEY")
    if not key or not by_table:
        return "not sent (no CAMERA_KEY or no seat is linked to a table)"
    body = json.dumps({"tables": [{"id": t, "taken": n} for t, n in by_table.items()]}).encode()
    req = urllib.request.Request(appconfig.app_url() + "/api/camera", body, {"Content-Type": "application/json", "X-Camera-Key": key})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return "sent " + r.read().decode()
    except urllib.error.HTTPError as e:
        return f"app refused it: {e.code}"
    except (urllib.error.URLError, OSError) as e:
        return f"app not reachable: {e}"


def clock(sec):
    sec = int(round(sec))
    return f"{sec // 3600}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


def summarise(video, args, seat_list, rows, events, duration, total):
    """The plain-text report: what happened over the whole video."""
    n, every = len(rows), args.every
    counts = [r["taken"] for r in rows]
    lines = [f"Occupancy summary for: {os.path.basename(video)}", ""]
    lines.append(f"Video length      : {clock(duration)} ({duration:.0f} s)")
    if args.loops > 1:
        lines.append(f"Simulated length  : {clock(total)} ({args.loops} repeats of the video; numbers beyond the first repeat are artificial)")
    lines.append(f"Samples           : {n}, one every {every:g} s of video time ({'real time' if args.realtime else 'fast replay'})")
    lines.append(f"Seats watched     : {len(seat_list)}")
    lines.append(f"Smoothing         : taken after {ON_SAMPLES} samples in a row, free after {OFF_SAMPLES}")
    lines.append(f"Standing filter   : a box taller than {args.standing_ratio:g} times its width is treated as standing")
    lines.append(f"Detection         : model {getattr(args, 'model', detect.DEFAULT_MODEL)}"
                 f"{', tiled' if getattr(args, 'tiled', False) else ''}"
                 f", seat overlap {getattr(args, 'overlap', 0):g} (0 = person's box must contain the seat dot)")
    lines.append("")
    avg = sum(counts) / n
    peak, low = max(counts), min(counts)
    lines.append(f"Average taken     : {avg:.1f} of {len(seat_list)} seats ({100 * avg / len(seat_list):.0f}%)")
    lines.append(f"Busiest moment    : {peak} seats taken, first at {clock(rows[counts.index(peak)]['t'])}")
    lines.append(f"Quietest moment   : {low} seats taken, first at {clock(rows[counts.index(low)]['t'])}")
    if total >= 600:
        w = max(1, int(300 / every))
        best = max(range(0, max(1, n - w + 1)), key=lambda i: sum(counts[i:i + w]))
        lines.append(f"Busiest 5 minutes : from {clock(rows[best]['t'])}, average {sum(counts[best:best + w]) / len(counts[best:best + w]):.1f} seats taken")
    lines += ["", "Per seat:", f"{'Seat':<6}{'Time taken':>11}{'Sit-downs':>11}{'Avg stay (s)':>14}"]
    for k, s in enumerate(seat_list):
        flags = [r["seats"][k] for r in rows]
        sits = sum(1 for i, f in enumerate(flags) if f and (i == 0 or not flags[i - 1]))
        taken_s = sum(flags) * every
        lines.append(f"{s['id']!s:<6}{100 * sum(flags) / n:>10.0f}%{sits:>11}{(taken_s / sits if sits else 0):>14.0f}")
    lines += ["", "Changes (video time):"]
    lines += [f"  {clock(t)}  seat {sid} {'taken' if taken else 'freed'}" for t, sid, taken in events] or ["  none"]
    lines += ["", "Notes: sit-downs count a seat that is already taken at the start as one. The average stay is the time taken",
              "divided by the sit-downs, so stays that run past the end of the video are cut short."]
    return "\n".join(lines)


def save_report(out, video, args, seat_list, rows, events, duration, first, last):
    """Write the CSV, the summary and the first and last marked pictures to the folder out. Returns the summary text.

    rows: [{"t", "people", "taken", "seats": [decided states]}]   events: [(t, seat id, taken)]
    first, last: ("sample", image, people, raw flags) for the first and last check. args needs every, loops, realtime, standing_ratio.
    """
    os.makedirs(out, exist_ok=True)
    tag = (re.sub(r"[^A-Za-z0-9]+", "_", os.path.splitext(os.path.basename(video))[0]).strip("_")[:30] or "video") + time.strftime("_%Y%m%d_%H%M%S")
    with open(os.path.join(out, f"occupancy_{tag}.csv"), "w", newline="", encoding="utf-8") as fh:
        wr = csv.writer(fh)
        wr.writerow(["video_time", "seconds", "people_found", "seats_taken"] + [f"seat_{s['id']}" for s in seat_list])
        for r in rows:
            wr.writerow([clock(r["t"]), f"{r['t']:g}", r["people"], r["taken"]] + [int(x) for x in r["seats"]])
    summary = summarise(video, args, seat_list, rows, events, duration, rows[-1]["t"] + args.every)
    with open(os.path.join(out, f"summary_{tag}.txt"), "w", encoding="utf-8") as fh:
        fh.write(summary + "\n")
    for name, frame, decided in (("first", first, rows[0]["seats"]), ("last", last, rows[-1]["seats"])):
        result = {"seats": [{**s, "taken": d} for s, d in zip(seat_list, decided)]}
        cv2.imwrite(os.path.join(out, f"marked_{tag}_{name}.jpg"), seats.draw_marked(frame, result), [cv2.IMWRITE_JPEG_QUALITY, 85])
    return summary


def main():
    ap = argparse.ArgumentParser(description="Replay a video as if it were live and log which seats are taken.")
    ap.add_argument("--video", help="video file (a name in videos/, or a path); default the newest in videos/")
    ap.add_argument("--seats-file", help="JSON file of seats instead of the calibration page")
    ap.add_argument("--every", type=float, default=3.0, help="seconds of video time between samples (default 3)")
    ap.add_argument("--realtime", action="store_true", help="wait so the replay runs at the video's own pace")
    ap.add_argument("--loops", type=int, default=1, help="play the video this many times to simulate a longer one (default 1)")
    ap.add_argument("--tiled", action="store_true", help="look at the picture in pieces: finds smaller people but is about 20x slower")
    ap.add_argument("--standing-ratio", type=float, default=seats.STANDING_RATIO,
                    help=f"a person box taller than this many times its width counts as standing, not sitting (default {seats.STANDING_RATIO}; "
                         "a steep camera angle shows legs under the table, so seated people need a higher number)")
    ap.add_argument("--model", default=detect.DEFAULT_MODEL, choices=list(detect.MODELS),
                    help=f"which detection model to use (default {detect.DEFAULT_MODEL}); bigger finds more people but is slower")
    ap.add_argument("--overlap", type=float, default=seats.OVERLAP_MIN,
                    help="also count a seat as taken when a seated person's box covers this share (0 to 1) of the seat's box, e.g. 0.3 "
                         "(default 0 = only when a person's box contains the seat's dot)")
    ap.add_argument("--post", action="store_true", help="send the seat counts to the app after every sample")
    ap.add_argument("--out", default=REPORTS, help="folder for the reports (default poc-vision/reports)")
    args = ap.parse_args()
    if args.every <= 0 or args.loops < 1:
        sys.exit("--every must be above 0 and --loops at least 1.")

    seats.STANDING_RATIO = args.standing_ratio  # seats.seated() reads this when it runs
    seats.OVERLAP_MIN = args.overlap  # seats.seat_taken() reads this
    video = find_video(args.video)
    seat_list = load_video_seats(args.seats_file)
    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if not cap.isOpened() or frames <= 0:
        sys.exit(f"Could not open the video: {video}")
    duration = frames / fps
    per_loop = max(1, int(duration // args.every) + (0 if duration % args.every == 0 else 1))
    print(f"{os.path.basename(video)}: {duration:.0f} s, {len(seat_list)} seats, a sample every {args.every:g} s "
          f"-> {per_loop * args.loops} samples" + (" (real time)" if args.realtime else ""))

    net, size = detect.load_model(args.model)
    finder = detect.find_people_tiled if args.tiled else detect.find_people
    states = [SeatState() for _ in seat_list]
    rows, events, first, last = [], [], None, None
    started = time.time()
    for loop in range(args.loops):
        for k in range(per_loop):
            t = loop * duration + k * args.every
            if args.realtime:
                time.sleep(max(0.0, started + t - time.time()))
            cap.set(cv2.CAP_PROP_POS_FRAMES, min(frames - 1, int(k * args.every * fps)))
            ok, img = cap.read()
            if not ok:
                print(f"  could not read the frame at {clock(t)}; skipped")
                continue
            h, w = img.shape[:2]
            people = finder(net, img, size)
            raw = [seats.seat_taken(people, s, w, h) for s in seat_list]
            for s, st, r in zip(seat_list, states, raw):
                if st.update(r):
                    events.append((t, s["id"], st.taken))
            decided = [st.taken for st in states]
            rows.append({"t": t, "people": len(people), "taken": sum(decided), "seats": decided})
            frame = ("sample", img, people, raw)
            first = first or frame
            last = frame
            note = post_counts(seat_list, states) if args.post else ""
            print(f"  {clock(t)}  people {len(people):2d}  taken {sum(decided)} of {len(seat_list)}  "
                  f"({time.time() - started:.1f}s elapsed) {note}")
    cap.release()
    if not rows:
        sys.exit("No frames could be read.")

    summary = save_report(args.out, video, args, seat_list, rows, events, duration, first, last)
    print("\n" + summary)
    print(f"\nFiles are in {args.out}")


if __name__ == "__main__":
    main()
