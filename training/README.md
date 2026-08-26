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

2. **Training** — [Ultralytics](https://github.com/ultralytics/ultralytics)
   YOLOv8, trained on the merged `data.yaml` at 640px. Two variants have been
   trained on this dataset:

   - **YOLOv8n (nano) — currently deployed.** Run/paused/resumed over
     several sessions, early-stopped at epoch 122 (of 150 scheduled) after
     20 epochs with no improvement. Best checkpoint: **epoch 102**.

     | Metric | Value |
     |---|---|
     | mAP50 | 0.945 |
     | mAP50-95 | 0.749 |
     | Precision | 0.971 |
     | Recall | 0.918 |

   - **YOLOv8s (small) — previously deployed, kept for reference.** Run for
     150 scheduled epochs, stopped at epoch 142 once accuracy had plateaued.
     Best checkpoint: **epoch 99**.

     | Metric | Value |
     |---|---|
     | mAP50 | 0.945 |
     | mAP50-95 | 0.744 |
     | Precision | 0.969 |
     | Recall | 0.927 |

   Nano matches or slightly beats the small model on mAP50, mAP50-95, and
   precision, at under a third of the checkpoint size and roughly 3.5x fewer
   parameters (3.2M vs 11.1M) — the small model still edges it out on recall.
   Metrics are computed on the full 990-image validation split.

3. **Export & quantize** — the checkpoint is exported to ONNX
   (`imgsz=640`, `nms=True`, `opset=12`) then quantized to INT8
   (`onnxruntime.quantization.quantize_dynamic`, `QUInt8` weights). For the
   deployed nano model this shrinks 11.8MB (FP32) to 3.4MB, with only a small
   accuracy drop re-validated on the exported ONNX graph itself (mAP50 0.929
   → 0.926, mAP50-95 0.738 → 0.734, precision 0.969 → 0.968, recall 0.918 →
   0.916) — the small model saw a similarly negligible quantization loss
   (42.8MB → 11.5MB, mAP50-95 0.543 → 0.545).

4. **Deploy** — the quantized `.onnx` is committed straight into
   `public/model/tile-detector.onnx`, where
   [`src/lib/vision.ts`](../src/lib/vision.ts) fetches and runs it
   client-side via onnxruntime-web (WASM). No image or model inference ever
   touches a server.

## Checkpoints

Raw Ultralytics checkpoints for both trained variants are kept here as a
durable backup of the training runs, in case either model ever needs to be
re-exported, fine-tuned further, or compared against a future run:

- `checkpoints/yolov8n-epoch102.pt` — the currently deployed model.
- `checkpoints/yolov8s-epoch99.pt` — the previously deployed model.

Resume training from either with:

```bash
yolo detect train model=training/checkpoints/yolov8n-epoch102.pt \
  data=<path-to-merged-data.yaml> resume=True
```

## Licensing note

MJOD-2136 is CC BY-NC-SA 4.0, which is more restrictive than this repo's own
license. The dataset itself isn't redistributed here (only the merge script,
which expects it to be downloaded separately); the trained weights are a
derived work, not the raw data, but the license's share-alike/non-commercial
terms should be kept in mind for anyone reusing the checkpoints.
