"""Live dashboard for the training runs: perHand (ml/long.sh) and matchDay
(ml/matchday.sh).

    python3 ml/dashboard.py [port]      then open http://127.0.0.1:8765

Reads each run's log, state file and what's on disk (self-play chunks,
trainer logs, arena tables); the page polls /status every few seconds.
Pause / resume / start go through ml/ctl.sh. Listens on 127.0.0.1 only.
"""

import glob
import json
import os
import re
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKUP = os.path.expanduser("~/Library/Mobile Documents/com~apple~CloudDocs/mjwaits-ml/runs")
LINE = re.compile(r"^\[(\d\d-\d\d \d\d:\d\d)\] (.*)$")
SELF_PLAY = ["Self-play", "Training", "Scoring"]

# Each run: where its files are, what its score means, and how its log
# lines name the steps. A step: what it's called, the model it makes, its
# self-play data folder (for chunk progress) and how many hands it plays.
RUNS = {
    "perHand": {
        "about": "Plays each hand for the most tai. Doesn't see the scoreboard.",
        "metric": "Net tai per hand vs the rule bots",
        "metricNote": "Same 2,048 hands every time (±~1 is luck). A step only replaces the best if it scores higher.",
        "log": "ml/runs/long.log",
        "state": "ml/runs/long/state",
        "logs": "ml/runs/long",
        "steps": [
            (r"^scoring the start", lambda m: {"title": "Scoring the starting network", "name": "start", "stages": ["Scoring"]}),
            (r"^DAgger", lambda m: {"title": "Correcting the rule-bot copy (DAgger)", "name": "dagger1", "data": "dagger1", "hands": 8000, "stages": SELF_PLAY}),
            (r"^round (\d+): .* (\d+) hands", lambda m: {"title": f"Self-play round {m[1]}: play, then PPO training", "name": f"long-{m[1]}", "data": f"long-{m[1]}", "hands": int(m[2]), "stages": SELF_PLAY}),
        ],
    },
    "matchDay": {
        "about": "Plays for the day's result: sees the scoreboard, hands left, the goal dial and each opponent's record.",
        "metric": "Utility per hand on 64-hand match days (goal 0.5)",
        "metricNote": "Tai plus half the placing bonus (1st +150 … 4th −150 a day), per hand. Same 2,048 hands every time.",
        "log": "ml/runs/matchday.log",
        "state": "ml/runs/matchday/state",
        "logs": "ml/runs/matchday",
        "steps": [
            (r"^matchDay data:", lambda m: {"title": "Rule bots play 20,000 hands of match days", "name": "matchday-rules", "stages": ["Rule-bot match days", "Copy training", "Scoring"]}),
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


def first_place(model):
    """matchDay arena tables: the network's 1st-place rate on the match days."""
    path = os.path.join(ROOT, "ml/runs", model, "arena.txt")
    if not os.path.exists(path):
        return None
    on = False
    for line in open(path):
        if "Utility/day" in line:
            on = True
        elif on and "(net)" in line:
            m = re.search(r"\)\s+\d+\s+([\d.]+)%", line)
            return float(m.group(1)) if m else None
    return None


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
            scores.append({"name": name, "label": label, "desc": desc, "score": float(sm.group(2)), "at": at, "best": "new best" in msg, "first": first_place(name) if key == "matchDay" else None})
        if "-> new best" in msg and scores:
            scores[-1]["best"] = True
        for pattern, make in cfg["steps"]:
            pm = re.match(pattern, msg)
            if pm:
                step = {"since": at, "stage": "self-play", **make(pm)}
        if step and ("training" in msg or msg.strip().startswith("PPO")):
            step["stage"] = "training"
    if step:
        step["chunks"] = max(1, step.get("hands", 0) // 1000)
        step["chunksDone"] = len(glob.glob(os.path.join(ROOT, "ml/data", step.get("data") or "-", "c*/manifest.json")))
        step["chunkFails"] = sum(int(m.group(1)) for e in entries if e["at"] >= step["since"] for m in [re.search(r"retrying (\d+) crashed", e["msg"])] if m)
        if step.get("data") and step["stage"] == "self-play" and step["chunksDone"] >= step["chunks"]:
            step["stage"] = "training"
        tl = os.path.join(ROOT, cfg["logs"], f"{step['name']}-train.log")
        if step["stage"] == "training" and os.path.exists(tl):
            ep = re.findall(r"^epoch (\d+)/(\d+)\s+(\d+)s", open(tl).read(), re.M)
            step["epoch"], step["epochs"], step["epochSecs"] = map(int, ep[-1]) if ep else (0, None, 0)
        # Training writes the model before scoring it.
        if step["stage"] == "training" and os.path.exists(os.path.join(ROOT, "ml/runs", step["name"], "policy.onnx")):
            step["stage"] = "scoring"
    st = read_state(os.path.join(ROOT, cfg["state"]))
    if st.get("best"):
        st["bestLabel"], st["bestDesc"] = describe(st["best"].split("/")[-1])
        st["bestFirst"] = first_place(st["best"].split("/")[-1]) if key == "matchDay" else None
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


def status():
    mine, total = training_cpu()
    return {
        "runs": [run_status(k) for k in RUNS],
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
    print(f"training dashboard on http://127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
