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
   YOLOv8, trained on the merged `data.yaml` at 640px. The deployed model is
   YOLOv8s, trained for 150 scheduled epochs (in practice run/paused/resumed
   over several sessions, stopped at epoch 142 once accuracy had plateaued).
   The best checkpoint across the whole run was **epoch 99**:

   | Metric | Value |
   |---|---|
   | mAP50 | 0.945 |
   | mAP50-95 | 0.744 |
   | Precision | 0.969 |
   | Recall | 0.927 |

   Metrics are computed on the full 990-image validation split.

3. **Export & quantize** — the checkpoint is exported to ONNX
   (`imgsz=640`, `nms=True`, `opset=12`) then quantized to INT8
   (`onnxruntime.quantization.quantize_dynamic`, `QUInt8` weights). This
   shrinks the model from 42.8MB (FP32) to 11.5MB with negligible accuracy
   loss — validated at mAP50-95 = 0.543 (FP32) vs 0.545 (INT8) on the full
   validation set.

4. **Deploy** — the quantized `.onnx` is committed straight into
   `public/model/`, where [`src/lib/vision.ts`](../src/lib/vision.ts) fetches
   and runs it client-side via onnxruntime-web (WASM). No image or model
   inference ever touches a server.

## Checkpoints

`checkpoints/yolov8s-epoch99.pt` is the raw Ultralytics checkpoint behind the
currently deployed model — the durable backup of the training run itself,
kept in case the model ever needs to be re-exported, fine-tuned further, or
compared against a future run. Resume training from it with:

```bash
yolo detect train model=training/checkpoints/yolov8s-epoch99.pt \
  data=<path-to-merged-data.yaml> resume=True
```

## Licensing note

MJOD-2136 is CC BY-NC-SA 4.0, which is more restrictive than this repo's own
license. The dataset itself isn't redistributed here (only the merge script,
which expects it to be downloaded separately); the trained weights are a
derived work, not the raw data, but the license's share-alike/non-commercial
terms should be kept in mind for anyone reusing the checkpoint.
