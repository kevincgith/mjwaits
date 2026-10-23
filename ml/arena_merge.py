"""Merge arena tables (scripts/ml-eval.ts output) played on separate sets of
hands into one table in the same format: every column averaged per seat
(the parts are the same size), the biggest win the largest of them.

    ml/.venv/bin/python ml/arena_merge.py part-0.txt part-1.txt ... > arena.txt
"""

import re
import sys

# A seat that never won shows "-" for its win-only columns (counted as 0).
N = r"(?:-?[\d.]+|-)"
ROW = re.compile(
    rf"^(?P<name>.+?)\s+(?P<net>-?[\d.]+)\s+(?P<win>[\d.]+)%\s+(?P<tsumo>{N})%?\s+(?P<dealin>[\d.]+)%\s+(?P<avgwin>{N})\s+(?P<avgloss>{N})"
    rf"\s+(?P<turn>{N})\s+(?P<calls>{N})\s+(?P<riichi>[\d.]+)%\s+(?P<lah>-?[\d.]+)\s+(?P<surrender>\d+)\s+(?P<best>\d+)\s*$"
)
HANDS = re.compile(r"^(\d+) hands .*?([\d.]+)% drawn")
NUMS = ["net", "win", "tsumo", "dealin", "avgwin", "avgloss", "turn", "calls", "riichi", "lah", "surrender"]


def main(paths):
    seats, hands, drawn = {}, 0, []
    for path in paths:
        for line in open(path):
            h = HANDS.match(line)
            if h:
                hands += int(h[1])
                drawn.append(float(h[2]))
                continue
            m = ROW.match(line.rstrip())
            if not m or m["name"].startswith("Bot"):
                continue
            s = seats.setdefault(m["name"].strip(), {"n": 0, "best": 0, **{k: 0.0 for k in NUMS}})
            s["n"] += 1
            for k in NUMS:
                s[k] += 0.0 if m[k] == "-" else float(m[k])
            s["best"] = max(s["best"], int(m["best"]))
    if not seats:
        raise SystemExit("no arena rows found")
    print(f"{hands} hands ({len(paths)} sets merged), {sum(drawn) / max(1, len(drawn)):.1f}% drawn")
    print("Bot                    Net/hand    Win  Tsumo  Deal-in  Avg win  Avg loss  Win turn  Calls/hand      叮  拉 net  投降  Best")
    for name, s in sorted(seats.items(), key=lambda kv: -kv[1]["net"] / kv[1]["n"]):
        a = {k: s[k] / s["n"] for k in NUMS}
        print(
            f"{name:<22} {a['net']:>8.2f} {a['win']:>5.1f}% {a['tsumo']:>5.1f}% {a['dealin']:>7.1f}% {a['avgwin']:>8.1f} {a['avgloss']:>9.1f}"
            f" {a['turn']:>9.1f} {a['calls']:>11.1f} {a['riichi']:>5.1f}% {a['lah']:>6.2f} {round(a['surrender']):>5d} {s['best']:>5d}"
        )


if __name__ == "__main__":
    main(sys.argv[1:])
