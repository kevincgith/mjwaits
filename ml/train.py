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


def load_many(spec):
    """--data a,b,c: several datasets with the same encoding and styles, joined."""
    parts = [load(d) for d in spec.split(",")]
    manifest = parts[0][0]
    for m, *_ in parts[1:]:
        if (m["obsSize"], m["numActions"], m["styles"]) != (manifest["obsSize"], manifest["numActions"], manifest["styles"]):
            raise SystemExit("datasets differ in encoding or styles")
    cat = lambda i: np.concatenate([p[i] for p in parts])
    extras = [p[4] for p in parts]
    # Match-day data (encoding v2): the per-hand rows, and each decision's
    # row, renumbered across the datasets.
    if all("_hands" in p[0] for p in parts):
        offsets = np.cumsum([0] + [len(p[0]["_hands"]) for p in parts[:-1]])
        manifest = {**manifest, "_hands": np.concatenate([p[0]["_hands"] for p in parts]), "_link": np.concatenate([p[0]["_link"] + o for p, o in zip(parts, offsets)])}
    return manifest, cat(1), cat(2), cat(3), (np.concatenate(extras) if all(e is not None for e in extras) else None)


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
    if manifest.get("match"):
        hands, link = [], []
        for shard in manifest["shards"]:
            w = shard["w"]
            h = np.fromfile(os.path.join(data_dir, f"hands-{w}.f32"), dtype=np.float32).reshape(-1, HAND_ROW)
            link.append(np.fromfile(os.path.join(data_dir, f"link-{w}.i32"), dtype=np.int32) + sum(len(x) for x in hands))
            hands.append(h)
        manifest["_hands"], manifest["_link"] = np.concatenate(hands), np.concatenate(link)
    return manifest, np.concatenate(obs), np.concatenate(mask), np.concatenate(meta), (np.concatenate(extra) if extra else None)


# ---- Match days (encoding v2, src/lib/ml/match.ts) --------------------------
# hands-*.f32 rows: goal, hand index, match length, totals before (4), after
# (4), and at the match's end (4; NaN if the match was cut short).
HAND_ROW = 15
PLACE_BONUS = np.array([300.0, 100.0, -100.0, -300.0])


def place_bonus(totals, seat):
    """match.ts placeBonus, vectorised: ties share the places they span."""
    mine = totals[:, seat][:, None]
    above = (totals > mine).sum(1)
    tied = (totals == mine).sum(1)
    cum = np.concatenate([[0], np.cumsum(PLACE_BONUS)])
    return (cum[above + tied] - cum[above]) / tied


def match_utility(totals, seat, goal):
    return totals[:, seat] + goal * place_bonus(totals, seat)


def board_features(goal, hand, length, totals, seat):
    """What a scoreboard looks like from `seat`: goal, how much of the day is
    left, our total, the others' gaps to us (in turn order) and our place."""
    me = totals[:, seat]
    gaps = [totals[:, (seat + r) % 4] - me for r in (1, 2, 3)]
    place = (totals > me[:, None]).sum(1)
    left = np.maximum(length - hand, 0)
    return np.stack([goal, left / 100, np.sqrt(left) / 10, me / 100, *[g / 100 for g in gaps], *[(place == p).astype(np.float32) for p in range(4)]], axis=1).astype(np.float32)


class BoardValue(nn.Module):
    """What a scoreboard is worth at the end of the day, in tai / 100 -
    learned from finished matches. Suphx calls this global reward prediction:
    a hand's reward is how much it moved this, so a late deal-in while
    leading costs what it really costs."""

    def __init__(self, width=128):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(11, width), nn.GELU(), nn.Linear(width, width), nn.GELU(), nn.Linear(width, 1))

    def forward(self, x):
        return self.net(x).squeeze(-1)


def fit_board_value(hands, device, epochs=30):
    done = np.isfinite(hands[:, 11])
    h = hands[done]
    X, Y = [], []
    for seat in range(4):
        # Every hand start of a finished match -> where it ended.
        X.append(board_features(h[:, 0], h[:, 1], h[:, 2], h[:, 3:7], seat))
        Y.append(match_utility(h[:, 11:15], seat, h[:, 0]) / 100)
    X, Y = np.concatenate(X), np.concatenate(Y).astype(np.float32)
    model = BoardValue().to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-4)
    Xt, Yt = torch.from_numpy(X).to(device), torch.from_numpy(Y).to(device)
    n = len(X)
    for epoch in range(epochs):
        perm = torch.randperm(n, device=device)
        for b in range(0, n, 4096):
            ix = perm[b : b + 4096]
            loss = F.smooth_l1_loss(model(Xt[ix]), Yt[ix])
            opt.zero_grad()
            loss.backward()
            opt.step()
    with torch.no_grad():
        err = (model(Xt) - Yt).abs().mean().item() * 100
    print(f"board value: {done.sum():,} hands of finished matches, mean error {err:.0f} tai")
    return model.eval()


def match_rewards(manifest, meta, device):
    """Each decision's reward: how much its hand moved the value of the
    deciding seat's scoreboard (the true end-of-day utility after the last
    hand), in the same units as the hand net it replaces."""
    hands, link = manifest["_hands"], manifest["_link"]
    model = fit_board_value(hands, device)
    rows, seats = hands[link], meta[:, 5]
    goal, hand, length = rows[:, 0], rows[:, 1], rows[:, 2]

    def value(totals, at):
        out = np.empty(len(rows), dtype=np.float32)
        for seat in range(4):
            sel = seats == seat
            x = torch.from_numpy(board_features(goal[sel], at[sel], length[sel], totals[sel], seat)).to(device)
            with torch.no_grad():
                out[sel] = model(x).cpu().numpy() * 100
        return out

    before = value(rows[:, 3:7], hand)
    after = value(rows[:, 7:11], hand + 1)
    # After the day's last hand there's nothing to predict.
    last = hand + 1 >= length
    exact = np.array([match_utility(rows[i : i + 1, 7:11], seats[i], goal[i : i + 1])[0] for i in np.where(last)[0]])
    after[last] = exact
    return after - before


def shaped_reward(styles, meta, extra, hand_value=None):
    """Per-decision reward: the hand's net tai for the deciding seat (scaled),
    plus each personality's shaping. extra columns: logp, own win tai, dealt in,
    discards made."""
    r = (meta[:, 2].astype(np.float32) if hand_value is None else hand_value.astype(np.float32)) / VALUE_SCALE
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
    meta = json.load(open(os.path.join(run_dir, "meta.json")))
    model = make_model(meta.get("arch", "mlp"), O, A, len(styles), state["scale"].numpy(), meta.get("width", width), meta.get("planes"))
    model.load_state_dict(state)
    return model.to(device)


_last_progress = [0.0]


def progress(epoch, epochs, b, n, t0):
    """A line every few seconds for the training dashboard: how far through
    the current epoch, and the time so far."""
    now = time.time()
    if now - _last_progress[0] >= 5:
        _last_progress[0] = now
        print(f"progress epoch {epoch + 1}/{epochs} {b}/{n} {now - t0:.0f}s", flush=True)


def masked_log_softmax(logits, mask):
    return F.log_softmax(logits.masked_fill(mask < 0.5, -1e9), dim=-1)


def rl(args):
    manifest, obs, mask, meta, extra = load_many(args.data)
    if extra is None:
        raise SystemExit("--rl needs self-play data (scripts/ml-selfplay.ts writes extra-*.f32)")
    n, O = obs.shape
    A = mask.shape[1]
    styles = manifest["styles"]
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = load_model(args.init, O, A, styles, args.width, device)
    # The anchor: the network every round should stay close to - the original
    # imitation network, not just the previous round, so drift can't build up.
    ref = load_model(args.ref or args.init, O, A, styles, args.width, device).eval()
    for p in ref.parameters():
        p.requires_grad_(False)
    # Match-day data: a hand is worth how much it moved the day's outcome.
    hand_value = match_rewards(manifest, meta, device) if "_hands" in manifest else None
    reward = shaped_reward(styles, meta, extra, hand_value)
    old_logp = extra[:, 0]
    # The temperature the hands were played at: the recorded log-probs are of
    # logits / T, so the ratio and the KL are taken at the same T.
    temp = float(manifest.get("temperature", 1) or 1)
    print(f"played at temperature {temp}")
    print(f"{n:,} self-play decisions; mean reward by style: " + " ".join(f"{s}:{reward[meta[:, 1] == i].mean():+.3f}" for i, s in enumerate(styles)))
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    idx = np.arange(n)
    rng = np.random.default_rng(1)
    t0 = time.time()
    skipped = 0
    for epoch in range(args.epochs):
        rng.shuffle(idx)
        stats = []
        for b in range(0, n, args.batch):
            progress(epoch, args.epochs, b, n, t0)
            ix = idx[b : b + args.batch]
            # A leftover sliver of a batch has no spread to normalise the
            # advantages by (one sample: std is NaN, and NaN weights are a
            # network that never wins) - skip it; it's reshuffled next epoch.
            if len(ix) < 64:
                continue
            o = torch.from_numpy(obs[ix].astype(np.float32)).to(device)
            m = torch.from_numpy(mask[ix].astype(np.float32)).to(device)
            a = torch.from_numpy(meta[ix, 0].astype(np.int64)).to(device)
            s = torch.from_numpy(meta[ix, 1].astype(np.int64)).to(device)
            r = torch.from_numpy(reward[ix]).to(device)
            lp_old = torch.from_numpy(old_logp[ix]).to(device)
            logits, value = model(o, s, m)
            logits = logits / temp
            logp_all = masked_log_softmax(logits, m)
            logp = logp_all.gather(1, a[:, None]).squeeze(1)
            adv = r - value.detach()
            adv = (adv - adv.mean()) / (adv.std() + 1e-6)
            ratio = torch.exp(logp - lp_old)
            pg = -torch.min(ratio * adv, torch.clamp(ratio, 1 - args.clip, 1 + args.clip) * adv).mean()
            with torch.no_grad():
                ref_logp = masked_log_softmax(ref(o, s, m)[0] / temp, m)
            kl = (ref_logp.exp() * (ref_logp - logp_all)).masked_fill(m < 0.5, 0).sum(-1).mean()
            loss = pg + args.value_weight * F.smooth_l1_loss(value, r) + args.kl * kl
            # Never let one bad batch poison the weights.
            if not torch.isfinite(loss):
                skipped += 1
                continue
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            stats.append((pg.item(), kl.item(), F.smooth_l1_loss(value, r).item()))
        pg_m, kl_m, v_m = np.mean(stats, axis=0)
        print(f"epoch {epoch + 1}/{args.epochs}  {time.time() - t0:.0f}s  policy {pg_m:+.4f}  KL to start {kl_m:.4f}  value {v_m:.4f}")
    if skipped:
        print(f"skipped {skipped} batches with a non-finite loss")
    if not all(torch.isfinite(p).all() for p in model.parameters()):
        raise SystemExit("training produced non-finite weights - not saving this network")
    init_meta = json.load(open(os.path.join(args.init, "meta.json")))
    export(model, O, A, args.out, styles, {"arch": init_meta.get("arch", "mlp"), "width": init_meta.get("width", args.width), "planes": init_meta.get("planes"), "init": args.init, "ref": args.ref or args.init, "data": args.data, "samples": int(n), "rl": True})


class TilePolicy(nn.Module):
    """The tile-kind architecture: each of the 34 kinds is a token holding its
    planes (hand, ponds, melds, the discard facts...), plus a summary of the
    table (scalars, style, a pooled view of all tokens). One shared network
    scores every kind - so what it learns about throwing one tile applies to
    all of them - for the discard and discard-and-叮 actions. The other
    actions (自摸, kong, pass, win, pung, claim kong, three chows) and the
    value come from the pooled table summary.
    """

    def __init__(self, obs_size, num_actions, num_styles, scale, num_planes, num_kinds=34, width=256, style_dim=8):
        super().__init__()
        self.register_buffer("scale", torch.tensor(scale, dtype=torch.float32))
        self.num_kinds = num_kinds
        self.num_planes = num_planes  # the per-kind planes come first; the rest are scalars
        self.plane_size = num_planes * num_kinds
        self.num_scalars = obs_size - self.plane_size
        self.num_actions = num_actions
        self.style = nn.Embedding(num_styles, style_dim)
        self.token_in = nn.Linear(self.num_planes, width)
        self.global_in = nn.Linear(self.num_scalars + style_dim, width)
        self.mix = nn.Sequential(nn.GELU(), nn.Linear(2 * width, width), nn.GELU(), nn.Linear(width, width), nn.GELU())
        self.tile_head = nn.Linear(width, 2)  # discard, discard + 叮
        self.global_head = nn.Sequential(nn.Linear(2 * width, width), nn.GELU())
        self.other = nn.Linear(width, num_actions - 2 * num_kinds)
        self.value = nn.Linear(width, 1)

    def forward(self, obs, style, mask):
        x = obs / self.scale
        planes = x[:, : self.plane_size].reshape(-1, self.num_planes, self.num_kinds).transpose(1, 2)  # [B, 34, P]
        scalars = x[:, self.plane_size :]
        g = self.global_in(torch.cat([scalars, self.style(style)], dim=-1))  # [B, W]
        t = self.token_in(planes)  # [B, 34, W]
        h = self.mix(torch.cat([t, g[:, None, :].expand_as(t)], dim=-1))  # [B, 34, W]
        tile_logits = self.tile_head(h)  # [B, 34, 2]
        pooled = torch.cat([h.mean(dim=1), g], dim=-1)
        z = self.global_head(pooled)
        logits = torch.cat([tile_logits[:, :, 0], tile_logits[:, :, 1], self.other(z)], dim=-1)
        logits = logits.masked_fill(mask < 0.5, -1e9)
        return logits, self.value(z).squeeze(-1)


def make_model(arch, O, A, num_styles, scale, width, planes=None):
    if arch == "tile":
        return TilePolicy(O, A, num_styles, scale, planes, width=width)
    return Policy(O, A, num_styles, scale, width=width)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="ml/data/run1")
    ap.add_argument("--out", default="ml/runs/bc1")
    ap.add_argument("--epochs", type=int, default=6)
    ap.add_argument("--batch", type=int, default=1024)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--width", type=int, default=512)
    ap.add_argument("--value-weight", type=float, default=0.25)
    ap.add_argument("--arch", default="tile", choices=["tile", "mlp"])
    ap.add_argument("--planes", type=int, default=None, help="per-kind planes (else from the data manifest)")
    ap.add_argument("--rl", action="store_true", help="PPO on self-play data, starting from --init")
    ap.add_argument("--init", default="ml/runs/bc2")
    ap.add_argument("--ref", default=None, help="network the KL penalty anchors to (default: --init)")
    ap.add_argument("--clip", type=float, default=0.2)
    ap.add_argument("--kl", type=float, default=0.05)
    args = ap.parse_args()
    if args.rl:
        if args.lr == 2e-3:
            args.lr = 2e-4
        if args.epochs == 6:
            args.epochs = 2
        return rl(args)

    manifest, obs, mask, meta, _ = load_many(args.data)
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
    planes = args.planes or manifest.get("numPlanes")
    if args.arch == "tile" and not planes:
        raise SystemExit("--arch tile needs the plane count: --planes N, or data recorded with numPlanes in its manifest")
    model = make_model(args.arch, O, A, len(styles), scale, args.width, planes).to(device)
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
            progress(epoch, args.epochs, b, len(train), t0)
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

    export(model, O, A, args.out, styles, {"arch": args.arch, "width": args.width, "planes": planes, "data": args.data, "samples": int(n), "history": history})


if __name__ == "__main__":
    main()
