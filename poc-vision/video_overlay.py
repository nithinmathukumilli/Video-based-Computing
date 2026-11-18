"""Show the seat check on the video itself: every seat is boxed red (taken) or blue (free) on every frame.

Two ways to watch:
  python video_overlay.py --live     plays in your browser at the video's own pace (http://localhost:8081, this PC only)
  python video_overlay.py --save     writes poc-vision/reports/overlay_<video>.mp4 as fast as possible, to play in any player

People are found (YOLOX-S) every --every seconds (default 1) and each seat is decided with the same rule and smoothing as
video_analysis.py. The picture is drawn on every frame; the boxes and seat colours change when a new check finishes. In
--live mode the check runs beside the playback, so the video never stutters and the header shows how old the last check is.
Seats and options are the same as video_analysis.py (calibration page, or --seats-file; --standing-ratio per camera).
--live also records every check and, when the video finishes or you press Ctrl+C, writes the occupancy CSV, the summary and
the first and last marked pictures to poc-vision/reports/ (turn off with --no-report). A report is written only if the
program ends normally: ending the process from Task Manager skips it.
Nothing leaves this PC: the live page is served only to this computer, and the saved file stays in reports/ (not committed).

Usage:  python video_overlay.py --live --seats-file my_seats.json --standing-ratio 2.8
        python video_overlay.py --save --video clip.mp4 --every 2
"""
import argparse
import os
import re
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2

import detect
import seats
import video_analysis as va

RED, BLUE, GREEN, GREY, WHITE, BLACK = (40, 40, 230), (230, 150, 20), (60, 200, 60), (170, 170, 170), (255, 255, 255), (0, 0, 0)  # BGR
PAGE = (b"<!doctype html><title>Seat check</title><body style='margin:0;background:#1f242f;color:#fff;font-family:sans-serif;"
        b"text-align:center'><img src='/stream' style='max-height:96vh;max-width:100%'><p>Red = taken, blue = free. "
        b"Press Ctrl+C in the terminal to stop.</p></body>")


class Checker:
    """Finds people and keeps each seat's decided state. check() takes one frame; the rest only reads the result."""

    def __init__(self, seat_list, tiled, model=detect.DEFAULT_MODEL):
        self.seat_list = seat_list
        self.net, self.size = detect.load_model(model)
        self.finder = detect.find_people_tiled if tiled else detect.find_people
        self.states = [va.SeatState() for _ in seat_list]
        self.people, self.checked_at, self.seconds = [], None, 0.0
        self.rows, self.events, self.first, self.last = [], [], None, None  # kept for the report written at the end

    def check(self, img, t):
        started = time.time()
        h, w = img.shape[:2]
        people = self.finder(self.net, img, self.size)
        raw = [seats.seat_taken(people, s, w, h) for s in self.seat_list]
        for s, st, r in zip(self.seat_list, self.states, raw):
            if st.update(r):
                self.events.append((t, s["id"], st.taken))
        decided = [st.taken for st in self.states]
        self.rows.append({"t": t, "people": len(people), "taken": sum(decided), "seats": decided})
        self.last = ("sample", img, people, raw)
        self.first = self.first or self.last
        self.people, self.checked_at, self.seconds = people, t, time.time() - started


def draw(img, checker, t, loop_note=""):
    """Draw people, seats and the header on a copy of the frame."""
    out = img.copy()
    h, w = out.shape[:2]
    scale = max(0.5, w / 1000)
    thick = max(1, int(round(w / 400)))
    for p in checker.people:
        x0, y0, x1, y1 = (int(v) for v in p["box"])
        cv2.rectangle(out, (x0, y0), (x1, y1), GREEN if seats.seated(p) else GREY, 1)
    taken = 0
    for s, st in zip(checker.seat_list, checker.states):
        colour = RED if st.taken else BLUE
        taken += bool(st.taken)
        bx0, by0, bx1, by1 = (int(v) for v in (s["box"][0] * w, s["box"][1] * h, s["box"][2] * w, s["box"][3] * h))
        cv2.rectangle(out, (bx0, by0), (bx1, by1), colour, thick + 1)
        cv2.circle(out, (int(s["x"] * w), int(s["y"] * h)), thick + 3, colour, -1)
        label = f"{s['id']} {'TAKEN' if st.taken else 'free'}"
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6 * scale, thick)
        cv2.rectangle(out, (bx0, by0 - th - 8), (bx0 + tw + 8, by0), colour, -1)
        cv2.putText(out, label, (bx0 + 4, by0 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.6 * scale, WHITE, thick, cv2.LINE_AA)
    age = "" if checker.checked_at is None else f"   last check {max(0.0, t - checker.checked_at):.1f}s ago ({checker.seconds:.2f}s to run)"
    text = f"{taken} taken, {len(checker.seat_list) - taken} free   video {va.clock(t)}{age}{loop_note}"
    cv2.rectangle(out, (0, 0), (w, int(46 * scale)), BLACK, -1)
    cv2.putText(out, text, (10, int(31 * scale)), cv2.FONT_HERSHEY_SIMPLEX, 0.6 * scale, WHITE, thick, cv2.LINE_AA)
    return out


def serve(latest, port):
    """Serve the newest frame as a motion-JPEG stream to this computer only."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/stream":
                self.send_response(200)
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                try:
                    while True:
                        jpg = latest["jpg"]
                        if jpg:
                            self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n")
                        time.sleep(0.03)
                except (BrokenPipeError, ConnectionError, OSError):
                    return
            else:
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(PAGE)

        def log_message(self, *a):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main():
    ap = argparse.ArgumentParser(description="Show the seat check on the video itself.")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--live", action="store_true", help="play in the browser at the video's own pace")
    mode.add_argument("--save", action="store_true", help="write an MP4 with the marks drawn on it")
    ap.add_argument("--video", help="video file (a name in videos/, or a path); default the newest in videos/")
    ap.add_argument("--seats-file", help="JSON file of seats instead of the calibration page")
    ap.add_argument("--every", type=float, default=1.0, help="seconds between checks (default 1)")
    ap.add_argument("--loops", type=int, default=1, help="--live: play the video this many times (default 1)")
    ap.add_argument("--tiled", action="store_true", help="look at the picture in pieces: finds smaller people but is about 20x slower")
    ap.add_argument("--standing-ratio", type=float, default=seats.STANDING_RATIO, help="see video_analysis.py")
    ap.add_argument("--model", default=detect.DEFAULT_MODEL, choices=list(detect.MODELS), help="see video_analysis.py")
    ap.add_argument("--overlap", type=float, default=seats.OVERLAP_MIN, help="see video_analysis.py")
    ap.add_argument("--port", type=int, default=8081, help="--live: port for the page (default 8081)")
    ap.add_argument("--no-open", action="store_true", help="--live: do not open the browser for me")
    ap.add_argument("--out", default=va.REPORTS, help="folder for the MP4 (--save) or the report (--live) (default poc-vision/reports)")
    ap.add_argument("--no-report", action="store_true", help="--live: do not write the occupancy log and summary at the end")
    args = ap.parse_args()
    if args.every <= 0 or args.loops < 1:
        sys.exit("--every must be above 0 and --loops at least 1.")

    seats.STANDING_RATIO = args.standing_ratio
    seats.OVERLAP_MIN = args.overlap
    video = va.find_video(args.video)
    checker = Checker(va.load_video_seats(args.seats_file), args.tiled, args.model)
    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if not cap.isOpened() or frames <= 0:
        sys.exit(f"Could not open the video: {video}")
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"{os.path.basename(video)}: {frames / fps:.0f} s, {w}x{h}, {len(checker.seat_list)} seats, a check every {args.every:g} s")

    if args.save:
        os.makedirs(args.out, exist_ok=True)
        tag = re.sub(r"[^A-Za-z0-9]+", "_", os.path.splitext(os.path.basename(video))[0]).strip("_")[:30] or "video"
        path = os.path.join(args.out, f"overlay_{tag}{time.strftime('_%Y%m%d_%H%M%S')}.mp4")
        writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
        if not writer.isOpened():
            sys.exit("Could not create the MP4 file on this PC.")
        next_t, i = 0.0, 0
        while True:
            ok, img = cap.read()
            if not ok:
                break
            t = i / fps
            if t >= next_t:
                checker.check(img, t)
                next_t = t + args.every
            writer.write(draw(img, checker, t))
            i += 1
        writer.release()
        print(f"Wrote {i} frames to {path}")
        return

    latest = {"jpg": None}
    serve(latest, args.port)
    url = f"http://localhost:{args.port}"
    print(f"Watch it at {url}  (this computer only). Press Ctrl+C to stop.")
    if not args.no_open:
        webbrowser.open(url)
    busy = threading.Event()

    def work(img, t):
        try:
            checker.check(img, t)
        finally:
            busy.clear()

    written = []

    def finish():
        """Write the CSV, summary and marked pictures for every check made so far (once)."""
        if written or args.no_report:
            return
        written.append(True)
        rows = list(checker.rows)
        if not rows:
            print("No checks were made, so there is no report.")
            return
        # a check can take longer than --every, so use the real gap between checks for the time-based figures
        gap = (rows[-1]["t"] - rows[0]["t"]) / (len(rows) - 1) if len(rows) > 1 else args.every
        duration = frames / fps
        played = int(rows[-1]["t"] // duration) + 1  # repeats actually started, in case it was stopped early
        report_args = argparse.Namespace(every=gap, loops=played, realtime=True, standing_ratio=args.standing_ratio,
                                          model=args.model, tiled=args.tiled, overlap=args.overlap)
        summary = va.save_report(args.out, video, report_args, checker.seat_list, rows, list(checker.events), duration, checker.first, checker.last)
        print("\n" + summary)
        print(f"\nOccupancy log, summary and marked pictures are in {args.out}")

    started = time.time()
    last = None
    try:
        for loop in range(args.loops):
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            for i in range(frames):
                ok, img = cap.read()
                if not ok:
                    break
                t = loop * frames / fps + i / fps
                time.sleep(max(0.0, started + t - time.time()))
                if not busy.is_set() and t >= getattr(checker, "next_t", 0.0):
                    busy.set()
                    checker.next_t = t + args.every
                    threading.Thread(target=work, args=(img.copy(), t), daemon=True).start()
                note = f"   (repeat {loop + 1} of {args.loops})" if args.loops > 1 else ""
                last = draw(img, checker, t, note)
                latest["jpg"] = cv2.imencode(".jpg", last, [cv2.IMWRITE_JPEG_QUALITY, 80])[1].tobytes()
        finish()
        print("The video has finished. The last picture stays on the page. Press Ctrl+C to stop.")
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("Stopped.")
    finally:
        finish()  # also covers Ctrl+C before the video ends


if __name__ == "__main__":
    main()
