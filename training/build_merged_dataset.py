"""Merges MahjongVis (YOLO format, 42 classes) and MJOD-2136 (COCO format,
34 classes with duplicate category ids) into one unified YOLO dataset.

Unified 42-class scheme (mjwaits tile order, honors then flowers/seasons
appended at the end so the first 34 line up with mjwaits's own 34 kinds):
  0-8   : 1m-9m   (Characters)
  9-17  : 1t-9t   (Dots/circle)
  18-26 : 1s-9s   (Bamboo)
  27-33 : 1z-7z   (East, South, West, North, Red, Green, White)
  34-37 : flower 1-4
  38-41 : season 1-4
"""
import json
import os
import shutil

SC = "/private/tmp/claude-501/-Users-kevin-Documents-Claude-mjwaits/866258ef-91f4-40a3-99af-f76709e05f84/scratchpad"
MAHJONGVIS = f"{SC}/repo/YOLO"
MJOD = os.path.expanduser("~/Downloads/mj data/coco_mahjong")
OUT = f"{SC}/merged"

UNIFIED_NAMES = (
    [f"{r}m" for r in range(1, 10)]
    + [f"{r}t" for r in range(1, 10)]
    + [f"{r}s" for r in range(1, 10)]
    + ["1z", "2z", "3z", "4z", "5z", "6z", "7z"]
    + [f"flower{r}" for r in range(1, 5)]
    + [f"season{r}" for r in range(1, 5)]
)
NAME_TO_IDX = {n: i for i, n in enumerate(UNIFIED_NAMES)}
assert len(UNIFIED_NAMES) == 42

MAHJONGVIS_OLD_NAMES = [
    "1B", "1C", "1D", "1F", "1S", "2B", "2C", "2D", "2F", "2S",
    "3B", "3C", "3D", "3F", "3S", "4B", "4C", "4D", "4F", "4S",
    "5B", "5C", "5D", "6B", "6C", "6D", "7B", "7C", "7D", "8B",
    "8C", "8D", "9B", "9C", "9D", "EW", "GD", "NW", "RD", "SW",
    "WD", "WW",
]
HONOR_UNIFIED = {"EW": "1z", "SW": "2z", "WW": "3z", "NW": "4z", "RD": "5z", "GD": "6z", "WD": "7z"}


def mahjongvis_name_to_unified(name: str) -> str:
    if name in HONOR_UNIFIED:
        return HONOR_UNIFIED[name]
    suit, rank = name[-1], name[:-1]
    if suit == "C":
        return f"{rank}m"
    if suit == "D":
        return f"{rank}t"
    if suit == "B":
        return f"{rank}s"
    if suit == "F":
        return f"flower{rank}"
    if suit == "S":
        return f"season{rank}"
    raise ValueError(name)


MAHJONGVIS_OLD_IDX_TO_UNIFIED_IDX = [NAME_TO_IDX[mahjongvis_name_to_unified(n)] for n in MAHJONGVIS_OLD_NAMES]

MJOD_HONOR_UNIFIED = {"east": "1z", "south": "2z", "west": "3z", "north": "4z", "red": "5z", "green": "6z", "white": "7z"}


def mjod_name_to_unified(name: str) -> str:
    if name in MJOD_HONOR_UNIFIED:
        return MJOD_HONOR_UNIFIED[name]
    suit, rank = name.split("_")
    rank = str(int(rank))
    if suit == "character":
        return f"{rank}m"
    if suit == "circle":
        return f"{rank}t"
    if suit == "bamboo":
        return f"{rank}s"
    raise ValueError(name)


def convert_mahjongvis_split(src_split: str, dst_split: str, prefix: str):
    img_dir = f"{MAHJONGVIS}/{src_split}/images"
    lbl_dir = f"{MAHJONGVIS}/{src_split}/labels"
    n_imgs = n_boxes = 0
    for fname in os.listdir(img_dir):
        stem = os.path.splitext(fname)[0]
        lbl_path = f"{lbl_dir}/{stem}.txt"
        if not os.path.exists(lbl_path):
            continue
        out_lines = []
        with open(lbl_path) as f:
            for line in f:
                parts = line.split()
                if not parts:
                    continue
                old_idx = int(parts[0])
                new_idx = MAHJONGVIS_OLD_IDX_TO_UNIFIED_IDX[old_idx]
                out_lines.append(" ".join([str(new_idx)] + parts[1:]))
                n_boxes += 1
        out_stem = f"mv_{prefix}_{stem}"
        shutil.copy(f"{img_dir}/{fname}", f"{OUT}/{dst_split}/images/{out_stem}{os.path.splitext(fname)[1]}")
        with open(f"{OUT}/{dst_split}/labels/{out_stem}.txt", "w") as f:
            f.write("\n".join(out_lines) + ("\n" if out_lines else ""))
        n_imgs += 1
    print(f"MahjongVis {src_split} -> {dst_split}: {n_imgs} images, {n_boxes} boxes")


def convert_mjod_split(ann_file: str, img_subdir: str, dst_split: str, prefix: str):
    with open(f"{MJOD}/annotations/{ann_file}") as f:
        coco = json.load(f)
    cat_id_to_unified = {c["id"]: NAME_TO_IDX[mjod_name_to_unified(c["name"])] for c in coco["categories"]}
    anns_by_image = {}
    for a in coco["annotations"]:
        anns_by_image.setdefault(a["image_id"], []).append(a)
    images_by_id = {im["id"]: im for im in coco["images"]}

    n_imgs = n_boxes = 0
    for img_id, im in images_by_id.items():
        w, h = im["width"], im["height"]
        anns = anns_by_image.get(img_id, [])
        out_lines = []
        for a in anns:
            cls = cat_id_to_unified[a["category_id"]]
            x, y, bw, bh = a["bbox"]
            xc = (x + bw / 2) / w
            yc = (y + bh / 2) / h
            nw = bw / w
            nh = bh / h
            out_lines.append(f"{cls} {xc:.6f} {yc:.6f} {nw:.6f} {nh:.6f}")
            n_boxes += 1
        stem = os.path.splitext(im["file_name"])[0]
        ext = os.path.splitext(im["file_name"])[1]
        out_stem = f"mjod_{prefix}_{stem}"
        src_img = f"{MJOD}/{img_subdir}/{im['file_name']}"
        if not os.path.exists(src_img):
            print("MISSING IMAGE", src_img)
            continue
        shutil.copy(src_img, f"{OUT}/{dst_split}/images/{out_stem}{ext}")
        with open(f"{OUT}/{dst_split}/labels/{out_stem}.txt", "w") as f:
            f.write("\n".join(out_lines) + ("\n" if out_lines else ""))
        n_imgs += 1
    print(f"MJOD {ann_file} -> {dst_split}: {n_imgs} images, {n_boxes} boxes")


if __name__ == "__main__":
    os.makedirs(f"{OUT}/train/images", exist_ok=True)
    os.makedirs(f"{OUT}/train/labels", exist_ok=True)
    os.makedirs(f"{OUT}/valid/images", exist_ok=True)
    os.makedirs(f"{OUT}/valid/labels", exist_ok=True)

    convert_mahjongvis_split("train", "train", "train")
    convert_mahjongvis_split("valid", "valid", "valid")
    convert_mahjongvis_split("test", "valid", "test")
    convert_mjod_split("instances_train2017.json", "train2017", "train", "train")
    convert_mjod_split("instances_val2017.json", "val2017", "valid", "val")

    with open(f"{OUT}/data.yaml", "w") as f:
        f.write("train: train/images\n")
        f.write("val: valid/images\n")
        f.write(f"nc: {len(UNIFIED_NAMES)}\n")
        f.write(f"names: {UNIFIED_NAMES!r}\n")

    n_train_imgs = len(os.listdir(f"{OUT}/train/images"))
    n_valid_imgs = len(os.listdir(f"{OUT}/valid/images"))
    print(f"\nTOTAL train images: {n_train_imgs}")
    print(f"TOTAL valid images: {n_valid_imgs}")
