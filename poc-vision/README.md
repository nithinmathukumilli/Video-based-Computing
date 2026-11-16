# POC: finding people in cafeteria photos

Step 1 of the live-feed idea: take a picture, find the people in it, draw a box round each one.
Everything runs on this PC. No picture, model or result is sent anywhere.

## What is used (all free, all with a licence that allows company use)

| Part | What | Licence |
|---|---|---|
| Detector | YOLOX-S and YOLOX-Tiny (Megvii), pretrained on COCO | Apache-2.0 |
| Runs through | OpenCV (`cv2.dnn`) | Apache-2.0 |
| Photos | Five photos from Wikimedia Commons | CC0, CC BY, CC BY-SA or public domain: see `images/CREDITS.md` |

Models were downloaded from the YOLOX GitHub release `0.1.1rc0` into `models/`.
Avoid the Ultralytics YOLOv5/v8/v11 models for company use: they are AGPL-3.0.

## Get the models

The `.onnx` files are not stored in the repository. Download them into `models/` (PowerShell):

```
New-Item -ItemType Directory -Force models
Invoke-WebRequest https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx    -OutFile models\yolox_s.onnx
Invoke-WebRequest https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx -OutFile models\yolox_tiny.onnx
```

## Run it

```
.venv\Scripts\python.exe detect.py                   # YOLOX-S on all photos in images/
.venv\Scripts\python.exe detect.py yolox_s --tiles   # also looks at each photo in pieces (finds small, far-away people)
.venv\Scripts\python.exe detect.py yolox_tiny        # the smaller, faster model
```

Boxed pictures go to `output/`, and counts plus box positions go to `output/detections_<model>.json`.

Set up the environment from scratch: `python -m venv .venv`, then `.venv\Scripts\python.exe -m pip install -r requirements.txt`.

## First results (people found, score at least 0.35)

| Photo | Scene | YOLOX-Tiny | YOLOX-S | YOLOX-S + tiles |
|---|---|---|---|---|
| photo1 | staff canteen, about 35 people visible | 10 | 14 | 31 |
| photo2 | huge dining hall, hundreds of people | 5 | 9 | 68 |
| photo3 | busy food court | 8 | 13 | 46 |
| photo4 | empty school cafeteria (should be 0) | 0 | 0 | 0 |
| photo5 | one table of 8 people | 8 | 9 | 10 (2 are duplicates) |

Speed on this PC (i5, no graphics card): about 0.13 s per photo for the whole photo, 2 to 5 s with tiles.

## What we learned

- Clear, close people are found reliably, and an empty room gives 0 (no false people).
- People far from the camera are missed unless the photo is looked at in pieces (tiles).
- Dense crowds are still under-counted, and one person can occasionally get two boxes.
- So the real design should not count people in the whole picture. It should look at the small patch around each table,
  where people are big and the question is only "is anyone sitting here?".

## Next steps

1. Mark each table (or seat) as a region on the photo.
2. A person counts as sitting at a table if their box overlaps that region.
3. Send "Table 12: 3 of 4 seats taken" to the app, and show it on the seat map as "from camera".
