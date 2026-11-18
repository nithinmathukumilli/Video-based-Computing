"""Save one frame of a video as the picture the calibration page shows, so seats can be marked on it.

The seats are marked on this picture (http://localhost:<port>/calibrate.html) and saved in the app. Mark them on a frame where
every chair you want to count is visible and, ideally, empty or clearly occupied. Use the same camera view as the video.

Usage:  python video_reference.py                      first frame of the newest video in videos/
        python video_reference.py --video clip.mp4 --at 12.5     the frame at 12.5 seconds
"""
import argparse
import os
import sys

import cv2

import video_analysis as va

DEFAULT_OUT = os.path.join(va.HERE, "..", "public", "camera", "reference.jpg")


def main():
    ap = argparse.ArgumentParser(description="Save one video frame as the calibration page's reference picture.")
    ap.add_argument("--video", help="video file (a name in videos/, or a path); default the newest in videos/")
    ap.add_argument("--at", type=float, default=0.0, help="seconds into the video (default 0)")
    ap.add_argument("--out", default=DEFAULT_OUT, help="where to save the picture (default public/camera/reference.jpg)")
    args = ap.parse_args()
    video = va.find_video(args.video)
    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if not cap.isOpened() or frames <= 0:
        sys.exit(f"Could not open the video: {video}")
    cap.set(cv2.CAP_PROP_POS_FRAMES, min(frames - 1, max(0, int(args.at * fps))))
    ok, img = cap.read()
    cap.release()
    if not ok:
        sys.exit("Could not read that frame.")
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    cv2.imwrite(args.out, img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(f"Saved {img.shape[1]}x{img.shape[0]} frame at {args.at:g} s of {os.path.basename(video)} to {os.path.abspath(args.out)}")


if __name__ == "__main__":
    main()
