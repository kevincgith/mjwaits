"""Turn exported human play into training shards.

    ml/.venv/bin/python ml/human.py mjwaits-my-play-2026-10-22.jsonl [more.jsonl ...] --out ml/data/human1

The Play table's "Record my play" (src/lib/ml/recorder.ts) exports one JSON
line per decision. This writes them in the same layout scripts/ml-data.ts
uses (obs/mask/meta shards + manifest), with a single style, "human" - so
the trainer can learn your style like any personality, or fine-tune a
network toward it.
"""

import argparse
import base64
import json
import os

import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--out", default="ml/data/human1")
    args = ap.parse_args()

    obs, mask, meta = [], [], []
    obs_size = num_actions = num_planes = None
    for path in args.files:
        with open(path) as f:
            header = json.loads(f.readline())
            if header.get("format") != "mjwaits-human-v1":
                raise SystemExit(f"{path}: not a Play export")
            if obs_size is None:
                obs_size, num_actions, num_planes = header["obsSize"], header["numActions"], header.get("numPlanes")
            elif (obs_size, num_actions) != (header["obsSize"], header["numActions"]):
                raise SystemExit(f"{path}: recorded with a different encoding")
            for line in f:
                r = json.loads(line)
                obs.append(np.frombuffer(base64.b64decode(r["obs"]), dtype=np.uint8))
                mask.append(np.frombuffer(base64.b64decode(r["mask"]), dtype=np.uint8))
                # action, style (0 = human), hand net, session net (unknown), kind, seat
                meta.append([r["action"], 0, r["handNet"], 0, r["kind"], 0])
    n = len(obs)
    os.makedirs(args.out, exist_ok=True)
    np.stack(obs).tofile(os.path.join(args.out, "obs-0.u8"))
    np.stack(mask).tofile(os.path.join(args.out, "mask-0.u8"))
    np.array(meta, dtype=np.int32).tofile(os.path.join(args.out, "meta-0.i32"))
    json.dump(
        {
            "obsSize": obs_size,
            "numPlanes": num_planes,
            "numActions": num_actions,
            "meta": ["action", "style", "handNet", "sessionNet", "kind", "seat"],
            "styles": ["human"],
            "shards": [{"w": 0, "samples": n}],
            "samples": n,
            "source": args.files,
        },
        open(os.path.join(args.out, "manifest.json"), "w"),
        indent=1,
    )
    print(f"{n:,} of your decisions -> {args.out}")


if __name__ == "__main__":
    main()
