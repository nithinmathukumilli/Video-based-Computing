"""Look at the camera frames, decide which seats are taken, and send "table X: n seats taken" to the app.

Only counts are sent: no picture and no person's details leave this script.
The seats come from the app's calibration page (see seats.py); the app address and key from ../.env or the environment.

Usage:  python post_camera.py                 one round, then stop
        python post_camera.py --every 150     repeat every 150 seconds (2.5 minutes)
        python post_camera.py --dry           show what would be sent, send nothing
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

import cv2

import appconfig
import seats

HERE = os.path.dirname(os.path.abspath(__file__))
PICTURES = os.path.join(HERE, "..", "public", "camera")


def one_round(dry):
    seat_list = seats.load_seats()
    per_frame, result = seats.analyse(seats=seat_list)
    # seats with no table can't be reported
    by_table = {}
    for s in result["seats"]:
        if s["table"]:
            by_table.setdefault(s["table"], []).append(s["taken"])
    tables = [{"id": tid, "taken": sum(flags)} for tid, flags in by_table.items()]
    print(f"  {len(result['seats'])} seats on {len(tables)} tables")
    for t in tables:
        print(f"  {t['id']}: {t['taken']} of {len(by_table[t['id']])} seats taken")
    if dry:
        return
    # the pictures the app shows (demo only): the newest frame with its seats marked, and a clean one for the calibration page
    os.makedirs(PICTURES, exist_ok=True)
    cv2.imwrite(os.path.join(PICTURES, "latest.jpg"), seats.draw_marked(per_frame[0], result), [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not os.path.exists(os.path.join(PICTURES, "reference.jpg")):
        cv2.imwrite(os.path.join(PICTURES, "reference.jpg"), per_frame[0][1], [cv2.IMWRITE_JPEG_QUALITY, 92])
    key = appconfig.setting("CAMERA_KEY")
    if not key:
        sys.exit("CAMERA_KEY is not set in .env, so the app would refuse this.")
    req = urllib.request.Request(appconfig.app_url() + "/api/camera", json.dumps({"tables": tables}).encode(), {"Content-Type": "application/json", "X-Camera-Key": key})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            print("  app says:", r.read().decode())
    except urllib.error.HTTPError as e:
        print("  app refused it:", e.code, e.read().decode())


def main():
    args = sys.argv[1:]
    every = int(args[args.index("--every") + 1]) if "--every" in args else 0
    while True:
        print(time.strftime("%H:%M:%S"), "looking at the camera frames")
        one_round("--dry" in args)
        if not every:
            break
        time.sleep(every)


if __name__ == "__main__":
    main()
