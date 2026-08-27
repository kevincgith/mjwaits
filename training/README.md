# Camera scan model training

Documents how the tile detector behind the "📷 Scan a hand" feature was
trained, so the run is reproducible and the deployed model's provenance is
clear. Everything here runs offline, outside the web app; the app itself only
ever loads the finished ONNX file from `public/model/`.

## Pipeline

1. **Dataset merge** — [`build_merged_dataset.py`](build_merged_dataset.py)
   combines two datasets into one unified 42-class YOLO-format dataset:
   - [MahjongVis](https://github.com/Andy8647/MahjongVis) (MIT) — synthetic/rendered tiles, YOLO format, 42 classes.
   - [MJOD-2136](https://github.com/jaheel/MJOD-2136) (CC BY-NC-SA 4.0) — 2,136 real photos, COCO format, 34 classes with duplicate category ids.

   Both label schemes are remapped by tile name (not raw index) onto one
   unified order. Bamboo uses "b" rather than mjwaits's own "s" (sou) so
   it stays distinct from the season classes' "s" suffix - these are just
   class-name strings, not mjwaits's own Suit type:

   ```
   0-8   : 1m-9m   (characters)
   9-17  : 1t-9t   (dots/circles)
   18-26 : 1b-9b   (bamboo)
   27-33 : 1z-7z   (honors: East, South, West, North, Red, Green, White)
   34-37 : 1f-4f   (flowers)
   38-41 : 1s-4s   (seasons)
   ```

   Result: 4,859 training images / 990 validation images.

2. **Base training** — [Ultralytics](https://github.com/ultralytics/ultralytics)
   YOLOv8, trained on the merged `data.yaml` at 640px. Two variants have been
   trained on this dataset:

   - **YOLOv8n (nano).** Run/paused/resumed over several sessions,
     early-stopped at epoch 122 (of 150 scheduled) after 20 epochs with no
     improvement. Best checkpoint: **epoch 102**.

     | Metric | Value |
     |---|---|
     | mAP50 | 0.945 |
     | mAP50-95 | 0.749 |
     | Precision | 0.971 |
     | Recall | 0.918 |

   - **YOLOv8s (small) — kept for reference, no longer deployed.** Run for
     150 scheduled epochs, stopped at epoch 142 once accuracy had plateaued.
     Best checkpoint: **epoch 99**.

     | Metric | Value |
     |---|---|
     | mAP50 | 0.945 |
     | mAP50-95 | 0.744 |
     | Precision | 0.969 |
     | Recall | 0.927 |

   Nano matched or slightly beat the small model on mAP50, mAP50-95, and
   precision, at under a third of the checkpoint size and roughly 3.5x fewer
   parameters (3.2M vs 11.1M), so it replaced the small model as deployed.
   Metrics are computed on the full 990-image validation split.

3. **Fine-tuning on a real physical set — currently deployed.** The base
   nano model, while accurate on the held-out split of its own training
   data, measurably underperformed on tiles it had never seen: bonus tiles
   (flowers/seasons) especially vary a lot between manufacturers, and even
   an honor tile (White Dragon, often a blank tile) can differ from set to
   set. Real photos of one physical set (53 photos, mixed angles/lighting/
   overlap) were collected, pre-labeled by running the base model over them,
   then corrected in [Roboflow](https://roboflow.com)'s annotation editor
   (36 of the 53 made it through review) and exported as YOLO Darknet TXT.

   Two data-quality issues turned up in that corrected export - not
   uncommon after a fast manual review pass - and were fixed before
   training: one image had a duplicate leftover box (two overlapping boxes
   on the same tile, one correctly labeled and one not), and another image
   had several boxes drawn on bare table rather than any tile, including
   one wrong-class label. Both were caught by scripting a duplicate-box
   (high-IoU, different class) and near-blank-crop (low pixel variance)
   sweep across every corrected label file, rather than by eyeballing all
   of them - worth doing on any future correction batch too.

   The cleaned 35 images were split: 27 oversampled 12x into the training
   set (to give them real weight against the ~4,859 existing images) and 8
   held back, untouched, as a dedicated validation set separate from the
   original 990 - specifically to measure the fix on this set's tiles, not
   just on the blended average. Fine-tuned from the base nano checkpoint
   (not resumed - a fresh run with the checkpoint as pretrained weights, a
   low learning rate (`lr0=0.001`), and its own epoch/patience budget) over
   two sessions totaling 29 epochs before early-stopping. Best checkpoint:
   **epoch 13** (of the second, 60-epoch-budgeted session).

   | Metric | Full validation (998 imgs) | This set's 8 held-out photos |
   |---|---|---|
   | mAP50 | 0.944 | 0.989 |
   | mAP50-95 | 0.752 | 0.941 |
   | Precision | 0.973 | 0.983 |
   | Recall | 0.913 | 0.996 |

   The held-out-photos column is the number that actually mattered here:
   precision on this specific set's tiles went from 0.81 (base nano) to
   0.98 after fine-tuning - confirming the base model really was weaker on
   real, unseen tile designs than the blended validation metrics suggested.

   17 of the original 53 photos never made it into this round (a Roboflow
   annotation-job mechanic capped how many images could be pulled from the
   upload batch into one job) - a second fine-tuning round on those,
   following the same process, is a natural next step.

4. **Export & quantize** — the checkpoint is exported to ONNX
   (`imgsz=640`, `nms=True`, `opset=12`) then quantized to INT8
   (`onnxruntime.quantization.quantize_dynamic`, `QUInt8` weights). This
   shrinks 11.8MB (FP32) to 3.4MB, with only a small accuracy drop
   re-validated on the exported ONNX graph itself (full validation: mAP50
   0.926 → 0.925, mAP50-95 0.738 → 0.737; the base nano and small model saw
   similarly negligible quantization loss).

5. **Deploy** — the quantized `.onnx` is committed straight into
   `public/model/tile-detector.onnx`, where
   [`src/lib/vision.ts`](../src/lib/vision.ts) fetches and runs it
   client-side via onnxruntime-web (WASM). No image or model inference ever
   touches a server.

## Checkpoints

Raw Ultralytics checkpoints and deployed ONNX artifacts are kept here as a
durable backup, in case any of them ever needs to be re-exported, fine-tuned
further, or compared against a future run:

- `checkpoints/yolov8n-ft1-epoch13.pt` — the currently deployed model's raw checkpoint (fine-tuned).
- `checkpoints/yolov8n-epoch102.pt` — the base nano checkpoint the fine-tune started from.
- `checkpoints/yolov8s-epoch99.pt` — the small model's raw checkpoint (no longer deployed).
- `checkpoints/tile-detector-yolov8n-epoch102.onnx` — the exact INT8 ONNX that was live before this fine-tuned swap.
- `checkpoints/tile-detector-yolov8s-epoch99.onnx` — the exact INT8 ONNX that was live before the swap from small to nano.

Restore any previous deployment with, e.g.:
`cp training/checkpoints/tile-detector-yolov8n-epoch102.onnx public/model/tile-detector.onnx`

Resume training from any `.pt` with:

```bash
yolo detect train model=training/checkpoints/yolov8n-ft1-epoch13.pt \
  data=<path-to-merged-data.yaml> resume=True
```

## Licensing note

MJOD-2136 is CC BY-NC-SA 4.0, which is more restrictive than this repo's own
license. The dataset itself isn't redistributed here (only the merge script,
which expects it to be downloaded separately); the trained weights are a
derived work, not the raw data, but the license's share-alike/non-commercial
terms should be kept in mind for anyone reusing the checkpoints.
