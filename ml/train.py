"""Train a style-conditioned mahjong policy from recorded bot games.

    ml/.venv/bin/python ml/train.py --data ml/data/run1 --out ml/runs/bc1 [--epochs 6]
    ml/.venv/bin/python ml/train.py --rl --init ml/runs/bc2 --data ml/data/sp1 --out ml/runs/rl1

Stage 2 (--rl): PPO on self-play data (scripts/ml-selfplay.ts), starting from
a trained network. Each decision's reward is the hand's net tai for its seat,
shaped per personality (see shaped_reward) - so a style is what it's rewarded
for, not a formula. A KL penalty toward the starting network keeps each
personality recognisable while it improves.

Stage 1 of the learned bots: behaviour cloning. One network learns to play
like every personality at once - a style id (which bot made the decision)
goes in alongside the position, so it learns what all good play shares and
how each personality differs. It also learns a value: how the hand went for
the deciding seat, which later self-play training (stage 2) builds on.

Reads the shards scripts/ml-data.ts writes (see its header), trains on the
Apple GPU when there is one (MPS), and exports ONNX for the arena and the
browser (src/lib/ml/policy.ts):
    inputs  obs   float32 [batch, obsSize]  - the raw encoded observation
            style int64   [batch]           - index into manifest styles
            mask  float32 [batch, actions]  - 1 = legal
    outputs logits float32 [batch, actions] - illegal actions at -1e9
            value  float32 [batch]          - expected hand net / VALUE_SCALE
"""

import argparse
import json
import math
import os
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

VALUE_SCALE = 30.0  # hand nets are tens of tai; scale them to around 1


def load(data_dir):
    manifest = json.load(open(os.path.join(data_dir, "manifest.json")))
    O, A = manifest["obsSize"], manifest["numActions"]
    obs, mask, meta, extra = [], [], [], []
    for shard in manifest["shards"]:
        w, n = shard["w"], shard["samples"]
        if n == 0:
            continue
        obs.append(np.fromfile(os.path.join(data_dir, f"obs-{w}.u8"), dtype=np.uint8).reshape(n, O))
        mask.append(np.fromfile(os.path.join(data_dir, f"mask-{w}.u8"), dtype=np.uint8).reshape(n, A))
        meta.append(np.fromfile(os.path.join(data_dir, f"meta-{w}.i32"), dtype=np.int32).reshape(n, 6))
        path = os.path.join(data_dir, f"extra-{w}.f32")
        if os.path.exists(path):
            extra.append(np.fromfile(path, dtype=np.float32).reshape(n, 4))
    return manifest, np.concatenate(obs), np.concatenate(mask), np.concatenate(meta), (np.concatenate(extra) if extra else None)


def shaped_reward(styles, meta, extra):
    """Per-decision reward: the hand's net tai for the deciding seat (scaled),
    plus each personality's shaping. extra columns: logp, own win tai, dealt in,
    discards made."""
    r = meta[:, 2].astype(np.float32) / VALUE_SCALE
    style = np.array(styles)[meta[:, 1]]
    win_tai, dealt_in, discards = extra[:, 1], extra[:, 2], extra[:, 3]
    won = win_tai > 0
    # The Speedster: winning early is worth more.
    r += np.where((style == "speedster") & won, 0.4 * np.clip(14 - discards, 0, 14) / 14, 0)
    # The Hunter: big hands are worth more, cheap ones less.
    r += np.where((style == "hunter") & won, 0.5 * np.clip(win_tai - 15, -10, 40) / 30, 0)
    # The Iron Wall: dealing in hurts double.
    r -= np.where(style == "wall", 0.6 * dealt_in, 0)
    return r


class Policy(nn.Module):
    def __init__(self, obs_size, num_actions, num_styles, scale, width=512, style_dim=8):
        super().__init__()
        # Per-feature scale (its max in the training data), so inputs land in 0..1.
        self.register_buffer("scale", torch.tensor(scale, dtype=torch.float32))
        self.style = nn.Embedding(num_styles, style_dim)
        self.trunk = nn.Sequential(
            nn.Linear(obs_size + style_dim, width),
            nn.GELU(),
            nn.Linear(width, width),
            nn.GELU(),
            nn.Linear(width, width // 2),
            nn.GELU(),
        )
        self.policy = nn.Linear(width // 2, num_actions)
        self.value = nn.Linear(width // 2, 1)

    def forward(self, obs, style, mask):
        x = torch.cat([obs / self.scale, self.style(style)], dim=-1)
        h = self.trunk(x)
        logits = self.policy(h).masked_fill(mask < 0.5, -1e9)
        return logits, self.value(h).squeeze(-1)


def export(model, O, A, out, styles, extra_meta):
    os.makedirs(out, exist_ok=True)
    torch.save(model.state_dict(), os.path.join(out, "policy.pt"))
    model.eval().cpu()
    dummy = (torch.zeros(1, O), torch.zeros(1, dtype=torch.int64), torch.ones(1, A))
    torch.onnx.export(
        model,
        dummy,
        os.path.join(out, "policy.onnx"),
        input_names=["obs", "style", "mask"],
        output_names=["logits", "value"],
        dynamic_axes={"obs": {0: "batch"}, "style": {0: "batch"}, "mask": {0: "batch"}, "logits": {0: "batch"}, "value": {0: "batch"}},
        opset_version=17,
        dynamo=False,
    )
    json.dump({"obsSize": O, "numActions": A, "styles": styles, "valueScale": VALUE_SCALE, **extra_meta}, open(os.path.join(out, "meta.json"), "w"), indent=1)
    print(f"saved {out}/policy.onnx")


def load_model(run_dir, O, A, styles, width, device):
    state = torch.load(os.path.join(run_dir, "policy.pt"), map_location="cpu")
    model = Policy(O, A, len(styles), state["scale"].numpy(), width=width)
    model.load_state_dict(state)
    return model.to(device)


def masked_log_softmax(logits, mask):
    return F.log_softmax(logits.masked_fill(mask < 0.5, -1e9), dim=-1)


def rl(args):
    manifest, obs, mask, meta, extra = load(args.data)
    if extra is None:
        raise SystemExit("--rl needs self-play data (scripts/ml-selfplay.ts writes extra-*.f32)")
    n, O = obs.shape
    A = mask.shape[1]
    styles = manifest["styles"]
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = load_model(args.init, O, A, styles, args.width, device)
    ref = load_model(args.init, O, A, styles, args.width, device).eval()
    for p in ref.parameters():
        p.requires_grad_(False)
    reward = shaped_reward(styles, meta, extra)
    old_logp = extra[:, 0]
    print(f"{n:,} self-play decisions; mean reward by style: " + " ".join(f"{s}:{reward[meta[:, 1] == i].mean():+.3f}" for i, s in enumerate(styles)))
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    idx = np.arange(n)
    rng = np.random.default_rng(1)
    t0 = time.time()
    for epoch in range(args.epochs):
        rng.shuffle(idx)
        stats = []
        for b in range(0, n, args.batch):
            ix = idx[b : b + args.batch]
            o = torch.from_numpy(obs[ix].astype(np.float32)).to(device)
            m = torch.from_numpy(mask[ix].astype(np.float32)).to(device)
            a = torch.from_numpy(meta[ix, 0].astype(np.int64)).to(device)
            s = torch.from_numpy(meta[ix, 1].astype(np.int64)).to(device)
            r = torch.from_numpy(reward[ix]).to(device)
            lp_old = torch.from_numpy(old_logp[ix]).to(device)
            logits, value = model(o, s, m)
            logp_all = masked_log_softmax(logits, m)
            logp = logp_all.gather(1, a[:, None]).squeeze(1)
            adv = r - value.detach()
            adv = (adv - adv.mean()) / (adv.std() + 1e-6)
            ratio = torch.exp(logp - lp_old)
            pg = -torch.min(ratio * adv, torch.clamp(ratio, 1 - args.clip, 1 + args.clip) * adv).mean()
            with torch.no_grad():
                ref_logp = masked_log_softmax(ref(o, s, m)[0], m)
            kl = (ref_logp.exp() * (ref_logp - logp_all)).masked_fill(m < 0.5, 0).sum(-1).mean()
            loss = pg + args.value_weight * F.smooth_l1_loss(value, r) + args.kl * kl
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            stats.append((pg.item(), kl.item(), F.smooth_l1_loss(value, r).item()))
        pg_m, kl_m, v_m = np.mean(stats, axis=0)
        print(f"epoch {epoch + 1}/{args.epochs}  {time.time() - t0:.0f}s  policy {pg_m:+.4f}  KL to start {kl_m:.4f}  value {v_m:.4f}")
    export(model, O, A, args.out, styles, {"init": args.init, "data": args.data, "samples": int(n), "rl": True})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="ml/data/run1")
    ap.add_argument("--out", default="ml/runs/bc1")
    ap.add_argument("--epochs", type=int, default=6)
    ap.add_argument("--batch", type=int, default=1024)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--width", type=int, default=512)
    ap.add_argument("--value-weight", type=float, default=0.25)
    ap.add_argument("--rl", action="store_true", help="PPO on self-play data, starting from --init")
    ap.add_argument("--init", default="ml/runs/bc2")
    ap.add_argument("--clip", type=float, default=0.2)
    ap.add_argument("--kl", type=float, default=0.05)
    args = ap.parse_args()
    if args.rl:
        if args.lr == 2e-3:
            args.lr = 2e-4
        if args.epochs == 6:
            args.epochs = 2
        return rl(args)

    manifest, obs, mask, meta, _ = load(args.data)
    n, O = obs.shape
    A = mask.shape[1]
    styles = manifest["styles"]
    print(f"{n:,} decisions, obs {O}, actions {A}, styles {styles}")

    # Hold out whole sessions' worth of the tail as validation (samples are
    # written session by session, so the last 10% per shard is unseen play).
    rng = np.random.default_rng(0)
    idx = np.arange(n)
    val = idx[int(n * 0.9):]
    train = idx[: int(n * 0.9)]

    scale = np.maximum(obs[train].max(axis=0).astype(np.float32), 1.0)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = Policy(O, A, len(styles), scale, width=args.width).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    steps = args.epochs * math.ceil(len(train) / args.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps)

    def batch(ix):
        o = torch.from_numpy(obs[ix].astype(np.float32)).to(device)
        m = torch.from_numpy(mask[ix].astype(np.float32)).to(device)
        mt = meta[ix]
        a = torch.from_numpy(mt[:, 0].astype(np.int64)).to(device)
        s = torch.from_numpy(mt[:, 1].astype(np.int64)).to(device)
        v = torch.from_numpy(mt[:, 2].astype(np.float32) / VALUE_SCALE).to(device)
        return o, s, m, a, v, mt

    def evaluate():
        model.eval()
        right = np.zeros(len(styles))
        total = np.zeros(len(styles))
        kind_right = np.zeros(2)
        kind_total = np.zeros(2)
        loss_sum = 0.0
        with torch.no_grad():
            for b in range(0, len(val), 4096):
                o, s, m, a, v, mt = batch(val[b : b + 4096])
                logits, value = model(o, s, m)
                loss_sum += F.cross_entropy(logits, a, reduction="sum").item()
                hit = (logits.argmax(-1) == a).cpu().numpy()
                for st in range(len(styles)):
                    sel = mt[:, 1] == st
                    right[st] += hit[sel].sum()
                    total[st] += sel.sum()
                for k in range(2):
                    sel = mt[:, 4] == k
                    kind_right[k] += hit[sel].sum()
                    kind_total[k] += sel.sum()
        model.train()
        return {
            "loss": loss_sum / len(val),
            "accuracy": float(right.sum() / total.sum()),
            "byStyle": {styles[i]: float(right[i] / max(1, total[i])) for i in range(len(styles))},
            "turn": float(kind_right[0] / max(1, kind_total[0])),
            "claim": float(kind_right[1] / max(1, kind_total[1])),
        }

    t0 = time.time()
    history = []
    for epoch in range(args.epochs):
        rng.shuffle(train)
        for b in range(0, len(train), args.batch):
            o, s, m, a, v, _ = batch(train[b : b + args.batch])
            logits, value = model(o, s, m)
            loss = F.cross_entropy(logits, a) + args.value_weight * F.smooth_l1_loss(value, v)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
        ev = evaluate()
        history.append(ev)
        print(
            f"epoch {epoch + 1}/{args.epochs}  {time.time() - t0:.0f}s  val loss {ev['loss']:.3f}  "
            f"acc {ev['accuracy']:.3f} (turn {ev['turn']:.3f}, claim {ev['claim']:.3f})  "
            + " ".join(f"{k}:{v:.2f}" for k, v in ev["byStyle"].items())
        )

    export(model, O, A, args.out, styles, {"data": args.data, "samples": int(n), "history": history})


if __name__ == "__main__":
    main()
