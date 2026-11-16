"""Find the people in photos with YOLOX (Apache-2.0), running through OpenCV, and draw a box round each one.

Usage:  python detect.py [model] [--tiles]    model = yolox_s (default) or yolox_tiny; --tiles also looks at the photo in pieces
        python detect.py yolox_s images/photo1.jpg images/photo2.jpg

Writes boxed pictures to output/ and the counts and box positions to output/detections_<model>.json.
Nothing is sent anywhere: the photo, the model and the result all stay on this PC.
"""
import glob
import json
import os
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
INPUT_SIZE = {"yolox_s": 640, "yolox_tiny": 416}  # the size each model was trained at
PERSON = 0  # class 0 is "person" in the COCO list that YOLOX uses
SCORE_MIN = 0.35  # how sure the model must be before a box counts
NMS_IOU = 0.45  # boxes overlapping more than this are treated as the same person


def letterbox(img, size):
    """Shrink the photo to fit a size x size square, keeping its shape; fill the rest with grey (114), as YOLOX expects."""
    h, w = img.shape[:2]
    r = min(size / h, size / w)
    resized = cv2.resize(img, (int(w * r), int(h * r)), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    canvas[: resized.shape[0], : resized.shape[1]] = resized
    return canvas, r


def decode(raw, size):
    """YOLOX gives boxes relative to a grid; turn them into pixel boxes (cx, cy, w, h) on the size x size square."""
    grids, strides = [], []
    for stride in (8, 16, 32):
        n = size // stride
        xv, yv = np.meshgrid(np.arange(n), np.arange(n))
        grids.append(np.stack((xv, yv), 2).reshape(1, -1, 2))
        strides.append(np.full((1, n * n, 1), stride))
    grids, strides = np.concatenate(grids, 1), np.concatenate(strides, 1)
    out = raw.copy()
    out[..., :2] = (out[..., :2] + grids) * strides
    out[..., 2:4] = np.exp(out[..., 2:4]) * strides
    return out


def find_people(net, img, size):
    canvas, r = letterbox(img, size)
    blob = canvas.astype(np.float32).transpose(2, 0, 1)[None]  # BGR, 0-255, channels first: what YOLOX wants
    net.setInput(blob)
    raw = net.forward()  # shape (1, boxes, 85)
    pred = decode(raw, size)[0]
    scores = pred[:, 4] * pred[:, 5 + PERSON]  # "is there something here" x "is it a person"
    keep = scores > SCORE_MIN
    boxes, scores = pred[keep, :4], scores[keep]
    if not len(scores):
        return []
    # (cx, cy, w, h) on the square -> (x, y, w, h) on the original photo
    xywh = np.stack([(boxes[:, 0] - boxes[:, 2] / 2) / r, (boxes[:, 1] - boxes[:, 3] / 2) / r, boxes[:, 2] / r, boxes[:, 3] / r], 1)
    idx = cv2.dnn.NMSBoxes(xywh.tolist(), scores.tolist(), SCORE_MIN, NMS_IOU)
    H, W = img.shape[:2]
    people = []
    for i in np.array(idx).reshape(-1):
        x, y, w, h = xywh[i]
        x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
        if x1 - x0 > 4 and y1 - y0 > 4:
            people.append({"box": [round(float(v), 1) for v in (x0, y0, x1, y1)], "score": round(float(scores[i]), 3)})
    return people


def find_people_tiled(net, img, size, tile=400, overlap=0.3):
    """Look at the photo in overlapping tiles, so people who are small in the whole photo are shown to the model larger.
    The whole photo is checked too, then duplicate boxes (the same person seen in two tiles) are merged."""
    H, W = img.shape[:2]
    found = list(find_people(net, img, size))
    step = max(1, int(tile * (1 - overlap)))
    ys = list(range(0, max(1, H - tile), step)) + [max(0, H - tile)]
    xs = list(range(0, max(1, W - tile), step)) + [max(0, W - tile)]
    for y in sorted(set(ys)):
        for x in sorted(set(xs)):
            crop = img[y : y + tile, x : x + tile]
            for p in find_people(net, crop, size):
                x0, y0, x1, y1 = p["box"]
                # ignore a box that just touches the edge of a tile: it is a person cut in half, and another tile has the whole person
                edge = 3
                cut = (x0 <= edge and x > 0) or (y0 <= edge and y > 0) or (x1 >= crop.shape[1] - edge and x + tile < W) or (y1 >= crop.shape[0] - edge and y + tile < H)
                if cut:
                    continue
                found.append({"box": [x0 + x, y0 + y, x1 + x, y1 + y], "score": p["score"]})
    if not found:
        return []
    xywh = [[b["box"][0], b["box"][1], b["box"][2] - b["box"][0], b["box"][3] - b["box"][1]] for b in found]
    idx = cv2.dnn.NMSBoxes(xywh, [b["score"] for b in found], SCORE_MIN, 0.5)
    return [found[i] for i in np.array(idx).reshape(-1)]


def draw(img, people, label):
    out = img.copy()
    thick = max(2, round(max(out.shape[:2]) / 600))
    for p in people:
        x0, y0, x1, y1 = (int(v) for v in p["box"])
        cv2.rectangle(out, (x0, y0), (x1, y1), (60, 200, 60), thick)
    text = f"{label}: {len(people)} people"
    scale = max(out.shape[:2]) / 1400
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 1.1 * scale + 0.4, 2)
    cv2.rectangle(out, (0, 0), (tw + 20, th + 24), (0, 0, 0), -1)
    cv2.putText(out, text, (10, th + 8), cv2.FONT_HERSHEY_SIMPLEX, 1.1 * scale + 0.4, (255, 255, 255), 2, cv2.LINE_AA)
    return out


def main():
    args = [a for a in sys.argv[1:] if a != "--tiles"]
    tiles = "--tiles" in sys.argv[1:]
    model = args[0] if args else "yolox_s"
    files = args[1:] or sorted(glob.glob(os.path.join(HERE, "images", "*.jpg")))
    tag = model + ("_tiles" if tiles else "")
    if model not in INPUT_SIZE:
        sys.exit(f"unknown model {model!r}; choose one of {', '.join(INPUT_SIZE)}")
    net = cv2.dnn.readNetFromONNX(os.path.join(HERE, "models", model + ".onnx"))
    size = INPUT_SIZE[model]
    os.makedirs(os.path.join(HERE, "output"), exist_ok=True)
    results = {}
    for f in files:
        img = cv2.imread(f)
        if img is None:
            print(f"cannot read {f}")
            continue
        t0 = time.perf_counter()
        people = find_people_tiled(net, img, size) if tiles else find_people(net, img, size)
        secs = time.perf_counter() - t0
        name = os.path.splitext(os.path.basename(f))[0]
        cv2.imwrite(os.path.join(HERE, "output", f"{name}_{tag}.jpg"), draw(img, people, tag), [cv2.IMWRITE_JPEG_QUALITY, 90])
        results[name] = {"people": len(people), "seconds": round(secs, 2), "size": [img.shape[1], img.shape[0]], "detections": people}
        print(f"{name}: {len(people):3d} people found in {secs:.2f}s  ({img.shape[1]}x{img.shape[0]})")
    with open(os.path.join(HERE, "output", f"detections_{tag}.json"), "w") as fh:
        json.dump({"model": tag, "score_min": SCORE_MIN, "photos": results}, fh, indent=1)


if __name__ == "__main__":
    main()
