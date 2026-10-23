"""Live dashboard for the training runs: perHand (ml/long.sh) and matchDay
(ml/matchday.sh).

    python3 ml/dashboard.py [port]      then open http://127.0.0.1:8765

Reads each run's log, state file and what's on disk - self-play chunks and
their live progress files, trainer logs, arena tables - and turns them into
progress, pace, the network-vs-table breakdown and plain-English insights.
The page polls /status every 2 seconds. Pause / resume / start go through
ml/ctl.sh. Listens on 127.0.0.1 only.
"""

import glob
import json
import os
import re
import subprocess
import sys
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKUP = os.path.expanduser("~/Library/Mobile Documents/com~apple~CloudDocs/mjwaits-ml/runs")
LINE = re.compile(r"^\[(\d\d-\d\d \d\d:\d\d)\] (.*)$")
SELF_PLAY = ["Self-play", "Training", "Scoring"]
ARENA_HANDS = 2048
# A 2,048-hand arena score is good to about this much either way (net tai/hand).
# perHand now plays challengers head to head on 8,192 hands (± ~1.2).
NOISE = {"perHand": 1.2, "matchDay": 1.5}

# Each run: where its files are, what its score means, and how its log
# lines name the steps. A step: what it's called, the model it makes, its
# data folder (for live progress) and how many hands it plays.
RUNS = {
    "perHand": {
        "about": "Plays each hand for the most tai. Doesn't see the scoreboard.",
        "metric": "Net tai per hand vs the rule bots",
        "metricNote": "Each round plays the best head to head on the same fresh 8,192 hands (±~1.2 is luck) and replaces it only if it scores higher there. Orange: the best's score on those same hands.",
        "log": "ml/runs/long.log",
        "state": "ml/runs/long/state",
        "logs": "ml/runs/long",
        "steps": [
            (r"^scoring the start", lambda m: {"title": "Scoring the starting network", "name": "start", "stages": ["Scoring"], "stage": "scoring"}),
            (r"^DAgger", lambda m: {"title": "Correcting the rule-bot copy (DAgger)", "name": "dagger1", "data": "dagger1", "hands": 8000, "stages": SELF_PLAY}),
            (r"^round (\d+): .* (\d+) hands", lambda m: {"title": f"Self-play round {m[1]}: play, then PPO training", "name": f"long-{m[1]}", "data": f"long-{m[1]}", "hands": int(m[2]), "stages": SELF_PLAY}),
        ],
    },
    "matchDay": {
        "about": "Plays for the day's result: sees the scoreboard, hands left, the goal dial and each opponent's record.",
        "metric": "Utility per hand on 64-hand match days (goal 0.5)",
        "metricNote": "Tai plus half the placing bonus (1st +150 … 4th −150 a day), per hand. Same 2,048 hands every time (±~1.5 is luck).",
        "log": "ml/runs/matchday.log",
        "state": "ml/runs/matchday/state",
        "logs": "ml/runs/matchday",
        "steps": [
            (r"^matchDay data:", lambda m: {"title": "Rule bots play 20,000 hands of match days", "name": "matchday-rules", "data": "matchday-rules", "hands": 20000, "flat": True, "stages": ["Rule-bot match days", "Copy training", "Scoring"]}),
            (r"^matchDay copy:", lambda m: {"title": "Copying the rule bots, with the match inputs", "name": "matchday-copy", "stages": ["Rule-bot match days", "Copy training", "Scoring"], "stage": "training"}),
            (r"^matchDay DAgger:", lambda m: {"title": "Correcting the copy (DAgger)", "name": "matchday-corrected", "data": "matchday-dagger", "hands": 8000, "stages": SELF_PLAY}),
            (r"^matchDay round (\d+): .* (\d+) hands", lambda m: {"title": f"Self-play round {m[1]}: play, then training on the day's outcome", "name": f"matchday-round-{m[1]}", "data": f"matchday-round-{m[1]}", "hands": int(m[2]), "stages": SELF_PLAY}),
        ],
    },
}

# Descriptive names for the models (the folders keep their short ids, which
# the scripts and the app's model files refer to).
NAMES = {
    "tile1": ("Rule-bot copy", "learned by copying the rule bots' decisions"),
    "dagger1": ("Rule-bot copy, corrected", "DAgger: re-taught where its own play went off the rule bots' path"),
    "matchday-copy": ("Rule-bot copy", "copied the rule bots on match days, with the scoreboard inputs"),
    "matchday-corrected": ("Rule-bot copy, corrected", "DAgger: re-taught where its own play went off the rule bots' path"),
}

# Recent (time, hands done) per run and step, for the pace and finish time.
PACE = {}


def describe(run_id):
    if run_id in NAMES:
        return NAMES[run_id]
    m = re.match(r"(?:long|matchday-round)-(\d+)$", run_id)
    if m:
        what = "rewarded by the day's outcome" if run_id.startswith("matchday") else "rewarded by each hand's tai"
        return (f"Self-play round {m.group(1)}", f"PPO on self-play from the best network so far, {what}")
    return (run_id, "")


def ctl_state(run):
    out = subprocess.run(["bash", "ml/ctl.sh", "status", run], cwd=ROOT, capture_output=True, text=True).stdout
    return out.splitlines()[0].split(": ")[-1] if out else "unknown"


def read_state(path):
    s = {}
    if os.path.exists(path):
        for line in open(path):
            k, _, v = line.strip().partition("=")
            s[k] = v.strip("'\"")
    return s


def read_int(path):
    try:
        return int(open(path).read().strip() or 0)
    except (OSError, ValueError):
        return 0


ARENA_ROW = re.compile(
    r"^(?P<name>.+?)\s+(?P<net>-?[\d.]+)\s+(?P<win>[\d.]+)%\s+(?P<tsumo>[\d.]+)%\s+(?P<dealin>[\d.]+)%\s+(?P<avgwin>[\d.]+)\s+(?P<avgloss>[\d.]+)"
    r"\s+[\d.]+\s+[\d.]+\s+(?P<riichi>[\d.]+)%"
)
MATCH_ROW = re.compile(r"^(?P<name>.+?)\s+(?P<days>\d+)\s+(?P<first>[\d.]+)%\s+(?P<place>[\d.]+)\s+(?P<utility>-?[\d.]+)$")


def arena(model):
    """A scored model's arena table: every seat's row, the network's marked,
    and (matchDay) the match-day places."""
    path = os.path.join(ROOT, "ml/runs", model, "arena.txt")
    if not os.path.exists(path):
        return None
    rows, places, in_match = [], {}, False
    for line in open(path):
        line = line.rstrip()
        if "Utility/day" in line:
            in_match = True
            continue
        m = (MATCH_ROW if in_match else ARENA_ROW).match(line)
        if not m or m["name"].startswith("Bot"):
            continue
        if in_match:
            places[m["name"].strip()] = {"days": int(m["days"]), "first": float(m["first"]), "place": float(m["place"]), "utility": float(m["utility"])}
        else:
            rows.append({"name": m["name"].strip(), "net": float(m["net"]), "win": float(m["win"]), "tsumo": float(m["tsumo"]), "dealin": float(m["dealin"]), "avgwin": float(m["avgwin"]), "avgloss": float(m["avgloss"]), "riichi": float(m["riichi"])})
    for r in rows:
        r["net_model"] = "(net)" in r["name"]
        r.update(places.get(r["name"], {}))
    rows.sort(key=lambda r: -r["net"])
    me = next((r for r in rows if r["net_model"]), None)
    return {"rows": rows, "me": me}


def train_metrics(path):
    """Per-epoch lines from a trainer log: accuracy (copying) or policy / KL /
    value (self-play), plus self-play's mean reward line."""
    if not os.path.exists(path):
        return None
    text = open(path).read()
    epochs = []
    for m in re.finditer(r"^epoch (\d+)/(\d+)\s+(\d+)s\s+(.*)$", text, re.M):
        e = {"epoch": int(m[1]), "of": int(m[2]), "secs": int(m[3])}
        rest = m[4]
        num = r"([-+]?(?:nan|inf|[\d.]+))"
        for key, pat in [("valLoss", r"val loss " + num), ("acc", r"acc " + num), ("accTurn", r"turn " + num), ("accClaim", r"claim " + num), ("policy", r"policy " + num), ("kl", r"KL to start " + num), ("value", r"value " + num)]:
            mm = re.search(pat, rest)
            if mm:
                v = float(mm[1])
                # NaN isn't JSON: flag it instead.
                if v != v or v in (float("inf"), float("-inf")):
                    e["broken"] = True
                    v = None
                e[key] = v
        epochs.append(e)
    reward = re.search(r"^([\d,]+) self-play decisions; mean reward by style: (.*)$", text, re.M)
    board = re.search(r"^board value: ([\d,]+) hands of finished matches, mean error (\d+) tai", text, re.M)
    prog = re.findall(r"^progress epoch (\d+)/(\d+) (\d+)/(\d+) (\d+)s$", text, re.M)
    out = {"epochs": epochs}
    if reward:
        out["decisions"] = reward[1]
        out["rewardByStyle"] = {k: float(v) for k, v in re.findall(r"(\w+):([-+\d.]+)", reward[2])}
    if board:
        out["boardValue"] = {"hands": board[1], "error": int(board[2])}
    if prog:
        e, E, b, n, t = map(int, prog[-1])
        out["live"] = {"epoch": e, "of": E, "frac": ((e - 1) + b / max(1, n)) / E, "secs": t}
    return out


def data_progress(step):
    """Hands played so far in a step's data folder: finished chunks count in
    full, unfinished ones by their workers' progress files."""
    d = os.path.join(ROOT, "ml/data", step["data"])
    if step.get("flat"):
        return sum(read_int(p) for p in glob.glob(os.path.join(d, "progress-*"))), 0
    done = 0
    finished = 0
    for c in glob.glob(os.path.join(d, "c*")):
        if not os.path.isdir(c):
            continue
        if os.path.exists(os.path.join(c, "manifest.json")):
            done += 1000
            finished += 1
        else:
            done += sum(read_int(p) for p in glob.glob(os.path.join(c, "progress-*")))
    return done, finished


def pace(key, step, done, total):
    """Hands per minute over the last few minutes, and the finish time."""
    q = PACE.setdefault((key, step["name"], step["stage"]), deque(maxlen=200))
    now = time.time()
    if not q or q[-1][1] != done:
        q.append((now, done))
    while len(q) > 2 and now - q[0][0] > 300:
        q.popleft()
    if len(q) < 2 or q[-1][1] <= q[0][1]:
        return None, None
    rate = (q[-1][1] - q[0][1]) / max(1e-6, q[-1][0] - q[0][0])
    eta = (total - done) / rate if rate > 0 else None
    return rate * 60, eta


def fmt_mins(secs):
    if secs is None:
        return None
    m = int(round(secs / 60))
    return f"{m // 60} h {m % 60:02d} min" if m >= 60 else f"{m} min"


def step_durations(entries, cfg):
    """How long each step took, from one step line to the next."""
    starts = []
    for e in entries:
        for pattern, make in cfg["steps"]:
            pm = re.match(pattern, e["msg"])
            if pm:
                starts.append((e["at"], make(pm)["name"]))
    def mins(a, b):
        ta, tb = time.strptime("2026-" + a, "%Y-%m-%d %H:%M"), time.strptime("2026-" + b, "%Y-%m-%d %H:%M")
        return (time.mktime(tb) - time.mktime(ta)) / 60
    out = {}
    # A resumed step logs its start twice; the first one counts.
    first = {}
    for at, name in starts:
        first.setdefault(name, at)
    ordered = sorted(first.items(), key=lambda kv: kv[1])
    for i, (name, at) in enumerate(ordered):
        end = ordered[i + 1][1] if i + 1 < len(ordered) else None
        if end:
            out[name] = mins(at, end)
    return out


def insights(key, scores, st, step, arena_best, arena_last):
    """Plain-English notes on where the run stands."""
    notes = []
    noise = NOISE[key]
    scores = [s for s in scores if not s.get("old")]
    # Health first: a network that never wins, or training that went NaN.
    if arena_best and arena_best["me"] and arena_best["me"]["win"] == 0:
        notes.append(("warn", "The best network never won a hand in its test - it's broken (often NaN weights). Stop the run and roll back."))
    if step and any(e.get("broken") for e in (step.get("train") or {}).get("epochs", [])):
        notes.append(("warn", "This round's training produced NaN values - the network it saves would be broken (training now refuses to save it)."))
    unit = "tai/hand" if key == "perHand" else "utility/hand"
    if st.get("best"):
        label, _ = describe(st["best"].split("/")[-1])
        notes.append(("neutral", f"The best is {label.lower()} ({st['best'].split('/')[-1]}). Scores on different hands can't be compared directly - each round is judged head to head against the best on the same hands."))
    rounds = [s for s in scores if re.search(r"(long|matchday-round)-\d+$", s["name"])]
    if rounds:
        kept = [s for s in rounds if s["best"]]
        try:
            best_score = float(st.get("best_score") or "nan")
        except ValueError:
            best_score = float("nan")
        worse = [s for s in rounds if s["score"] < (s["vsBest"] if s.get("vsBest") is not None else best_score) - noise]
        if kept:
            notes.append(("good", f"{len(kept)} of {len(rounds)} self-play round{'s' if len(rounds) > 1 else ''} beat the best and replaced it."))
        else:
            notes.append(("warn", f"None of {len(rounds)} self-play round{'s' if len(rounds) > 1 else ''} beat the best yet" + (f" - {len(worse)} scored clearly worse, so self-play is pulling it away from good play." if worse else ".")))
        if len(worse) >= 2 and not kept:
            notes.append(("warn", "Two or more clearly worse rounds in a row: the self-play settings (learning rate, KL anchor, reward) likely need changing rather than more rounds."))
    if arena_best and arena_best["me"]:
        me = arena_best["me"]
        others = [r for r in arena_best["rows"] if not r["net_model"]]
        avg = lambda k: sum(r[k] for r in others) / len(others)
        notes.append(("neutral", f"The best network wins {me['win']:.1f}% of hands (the rule bots average {avg('win'):.1f}%) and deals in on {me['dealin']:.1f}% ({avg('dealin'):.1f}%), averaging {me['avgwin']:.0f} tai a win."))
        rank = [r["name"] for r in arena_best["rows"]].index(me["name"]) + 1
        notes.append(("good" if rank == 1 else "neutral", f"It finishes {['1st', '2nd', '3rd', '4th'][rank - 1]} of 4 at the arena table on tai." + ("" if "first" not in me else f" On match days it's 1st {me['first']:.0f}% of the time (25% is even), average place {me['place']:.2f}.")))
    if arena_last and arena_best and arena_last is not arena_best and arena_last["me"] and arena_best["me"]:
        a, b = arena_last["me"], arena_best["me"]
        diffs = []
        if abs(a["win"] - b["win"]) >= 1:
            diffs.append(f"wins {'more' if a['win'] > b['win'] else 'less'} often ({a['win']:.1f}% vs {b['win']:.1f}%)")
        if abs(a["dealin"] - b["dealin"]) >= 1:
            diffs.append(f"deals in {'more' if a['dealin'] > b['dealin'] else 'less'} ({a['dealin']:.1f}% vs {b['dealin']:.1f}%)")
        if abs(a["avgwin"] - b["avgwin"]) >= 2:
            diffs.append(f"wins {'bigger' if a['avgwin'] > b['avgwin'] else 'smaller'} hands ({a['avgwin']:.0f} vs {b['avgwin']:.0f} tai)")
        if diffs:
            notes.append(("neutral", "The latest step, against the best: it " + ", ".join(diffs) + "."))
    if step and (step.get("train") or {}).get("rewardByStyle"):
        r = step["train"]["rewardByStyle"]
        lo, hi = min(r, key=r.get), max(r, key=r.get)
        notes.append(("neutral", f"In this round's self-play, {hi} did best ({r[hi]:+.3f}) and {lo} worst ({r[lo]:+.3f}) by its own reward."))
    if step and (step.get("train") or {}).get("boardValue"):
        bv = step["train"]["boardValue"]
        notes.append(("neutral", f"The board value learned from {bv['hands']} hands of finished match days predicts the day's end to within {bv['error']} tai on average."))
    return [{"tone": t, "text": x} for t, x in notes]


def run_status(key):
    cfg = RUNS[key]
    path = os.path.join(ROOT, cfg["log"])
    lines = open(path).read().splitlines() if os.path.exists(path) else []
    entries, scores, step = [], [], None
    for raw in lines:
        m = LINE.match(raw)
        if not m:
            continue
        at, msg = m.groups()
        entries.append({"at": at, "msg": msg})
        sm = re.match(r"\s+(ml/runs/\S+|[\w-]+): (-?\d+(?:\.\d+)?)", msg)
        if sm:
            name = sm.group(1).split("/")[-1]
            label, desc = describe(name)
            vs = re.search(r"vs best (-?[\d.]+)", msg)
            scores.append({"name": name, "label": label, "desc": desc, "score": float(sm.group(2)), "at": at, "best": "new best" in msg, "vsBest": float(vs[1]) if vs else None})
        if "-> new best" in msg and scores:
            scores[-1]["best"] = True
        # The move to head-to-head scoring: earlier scores were single
        # 2,048-hand tests, kept but marked; the re-scoring picks the best.
        if msg.startswith("re-scoring"):
            for sc in scores:
                sc["old"] = True
            step = {"since": at, "title": "Re-scoring tile1, dagger1 and round 3 on the same 8,192 hands", "name": "rescore", "stages": ["Scoring"], "stage": "scoring"}
        bm = re.match(r"\s+-> best on the bigger test: (\S+)", msg)
        if bm:
            for sc in scores:
                if not sc.get("old") and sc["name"] == bm[1].split("/")[-1]:
                    sc["best"] = True
        for pattern, make in cfg["steps"]:
            pm = re.match(pattern, msg)
            if pm:
                step = {"since": at, "stage": "self-play", **make(pm)}
        if step and ("training" in msg or msg.strip().startswith("PPO")):
            step["stage"] = "training"
    durations = step_durations(entries, cfg)
    for s in scores:
        a = arena(s["name"])
        s["arena"] = a["me"] if a else None
        s["mins"] = durations.get(s["name"])
    if step:
        if step.get("data"):
            done, finished = data_progress(step)
            step["handsDone"], step["chunksDone"] = done, finished
            step["chunks"] = max(1, step["hands"] // 1000)
            if step["stage"] == "self-play" and not step.get("flat") and finished >= step["chunks"]:
                step["stage"] = "training"
        if step.get("flat") and os.path.exists(os.path.join(ROOT, "ml/data", step["data"], "manifest.json")):
            step["stage"] = "training"
        step["chunkFails"] = sum(int(m.group(1)) for e in entries if e["at"] >= step["since"] for m in [re.search(r"retrying (\d+) crashed", e["msg"])] if m)
        trained = "matchday-copy" if step["name"] == "matchday-rules" else step["name"]
        step["train"] = train_metrics(os.path.join(ROOT, cfg["logs"], f"{trained}-train.log"))
        # Training writes the model, then it's scored.
        if step["stage"] == "training" and os.path.exists(os.path.join(ROOT, "ml/runs", trained, "policy.onnx")):
            step["stage"] = "scoring"
        # Progress and pace for whichever stage is running.
        prog = None
        if step["stage"] == "self-play" and step.get("data"):
            prog = (step["handsDone"], step["hands"], "hands")
        elif step["stage"] == "training" and step["train"] and step["train"].get("live"):
            live = step["train"]["live"]
            prog = (live["frac"] * 1000, 1000, "training")
            step["epochLive"] = live
        elif step["stage"] == "scoring":
            ap = os.path.join(ROOT, "ml/runs", trained, "arena.progress")
            if os.path.exists(ap):
                try:
                    a, b = map(int, open(ap).read().split())
                    prog = (a, b, "arena hands")
                except ValueError:
                    pass
        if prog:
            done, total, unit = prog
            rate, eta = pace(key, step, done, total)
            step["progress"] = {"done": done, "total": total, "unit": unit, "frac": min(1, done / max(1, total)), "perMin": rate, "eta": fmt_mins(eta)}
    # The training card: this step's, or the last finished one's.
    shown = None
    if step and step.get("train") and step["train"]["epochs"] or (step and step.get("epochLive")):
        shown = {"of": step["name"], "current": True, **step["train"]}
    else:
        for sc in reversed(scores):
            tm = train_metrics(os.path.join(ROOT, cfg["logs"], f"{sc['name']}-train.log"))
            if tm and tm["epochs"]:
                shown = {"of": sc["name"], "current": False, **tm}
                break
    st = read_state(os.path.join(ROOT, cfg["state"]))
    best_arena = last_arena = None
    if st.get("best"):
        best_id = st["best"].split("/")[-1]
        st["bestLabel"], st["bestDesc"] = describe(best_id)
        best_arena = arena(best_id)
    if scores:
        last_arena = arena(scores[-1]["name"])
        if best_arena and scores[-1]["name"] == st.get("best", "").split("/")[-1]:
            last_arena = best_arena
    backup = os.path.join(BACKUP, os.path.relpath(os.path.join(ROOT, cfg["state"]), os.path.join(ROOT, "ml/runs")))
    return {
        "key": key,
        "about": cfg["about"],
        "metric": cfg["metric"],
        "metricNote": cfg["metricNote"],
        "run": ctl_state(key),
        "state": st,
        "step": step,
        "scores": scores,
        "table": best_arena,
        "training": shown,
        "insights": insights(key, scores, st, step, best_arena, last_arena),
        "log": entries[-40:],
        "started": entries[0]["at"] if entries else None,
        "backup": time.strftime("%m-%d %H:%M", time.localtime(os.path.getmtime(backup))) if os.path.exists(backup) else None,
    }


def training_cpu():
    """Cores in use by the training processes, and by everything."""
    out = subprocess.run(["ps", "-Ao", "%cpu=,command="], capture_output=True, text=True).stdout
    mine = total = 0.0
    for line in out.splitlines():
        cpu, _, cmd = line.strip().partition(" ")
        try:
            c = float(cpu)
        except ValueError:
            continue
        total += c
        if re.search(r"ml-selfplay|ml-eval|ml-data|ml/train\.py|\.ml-md-", cmd):
            mine += c
    return round(mine / 100, 1), round(total / 100, 1)


def safe_run_status(key):
    """A run's status; if reading its files fails (one caught mid-write, say),
    a minimal entry instead of taking the whole page down."""
    try:
        return run_status(key)
    except Exception as e:  # noqa: BLE001 - the dashboard must keep answering
        return {"key": key, "about": RUNS[key]["about"], "metric": RUNS[key]["metric"], "metricNote": RUNS[key]["metricNote"], "run": ctl_state(key), "state": {}, "step": None, "scores": [], "table": None, "training": None, "insights": [{"tone": "warn", "text": f"Couldn't read this run's files just now ({type(e).__name__}); retrying."}], "log": [], "started": None, "backup": None}


def status():
    mine, total = training_cpu()
    return {
        "runs": [safe_run_status(k) for k in RUNS],
        "cpuTraining": mine,
        "cpuTotal": total,
        "cpus": os.cpu_count(),
        "now": time.strftime("%m-%d %H:%M:%S"),
    }


class Handler(BaseHTTPRequestHandler):
    def send(self, code, body, kind):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/status":
            self.send(200, json.dumps(status()), "application/json")
        elif self.path in ("/", "/index.html"):
            self.send(200, open(os.path.join(ROOT, "ml/dashboard.html"), "rb").read(), "text/html; charset=utf-8")
        else:
            self.send(404, "not found", "text/plain")

    def do_POST(self):
        parts = self.path.strip("/").split("/")
        if len(parts) != 3 or parts[0] != "ctl" or parts[1] not in RUNS or parts[2] not in ("pause", "resume", "start"):
            return self.send(404, "not found", "text/plain")
        out = subprocess.run(["bash", "ml/ctl.sh", parts[2], parts[1]], cwd=ROOT, capture_output=True, text=True)
        self.send(200, json.dumps({"out": (out.stdout + out.stderr).strip()}), "application/json")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    # Both loopbacks, so http://localhost works whichever one it resolves to.
    import socket
    import threading

    class V6(ThreadingHTTPServer):
        address_family = socket.AF_INET6

    try:
        v6 = V6(("::1", port), Handler)
        threading.Thread(target=v6.serve_forever, daemon=True).start()
    except OSError:
        pass
    print(f"training dashboard on http://localhost:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
