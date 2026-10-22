"""Live dashboard for the long training run (ml/long.sh).

    python3 ml/dashboard.py [port]      then open http://127.0.0.1:8765

Reads ml/runs/long.log, ml/runs/long/state and the self-play chunks on disk;
the page polls /status every few seconds. Pause / resume / stop go through
ml/ctl.sh. Listens on 127.0.0.1 only.
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
LOG = os.path.join(ROOT, "ml/runs/long.log")
STATE = os.path.join(ROOT, "ml/runs/long/state")
BACKUP = os.path.expanduser("~/Library/Mobile Documents/com~apple~CloudDocs/mjwaits-ml/runs/long/state")
LINE = re.compile(r"^\[(\d\d-\d\d \d\d:\d\d)\] (.*)$")


# Descriptive names for the runs (the folders keep their short ids, which
# the scripts and the app's model files refer to).
NAMES = {
    "tile1": ("Rule-bot copy", "learned by copying the rule bots' decisions"),
    "dagger1": ("Rule-bot copy, corrected", "DAgger: re-taught where its own play went off the rule bots' path"),
}


def describe(run_id):
    if run_id in NAMES:
        return NAMES[run_id]
    m = re.match(r"long-(\d+)$", run_id)
    if m:
        return (f"Self-play round {m.group(1)}", "PPO on self-play hands from the best network so far")
    return (run_id, "")


def run_state():
    out = subprocess.run(["bash", "ml/ctl.sh", "status", "perHand"], cwd=ROOT, capture_output=True, text=True).stdout
    return out.splitlines()[0].split(": ")[-1] if out else "unknown"


def read_state():
    s = {}
    if os.path.exists(STATE):
        for line in open(STATE):
            k, _, v = line.strip().partition("=")
            s[k] = v.strip("'\"")
    return s


def parse_log():
    lines = open(LOG).read().splitlines() if os.path.exists(LOG) else []
    entries, scores, step = [], [], None
    for raw in lines:
        m = LINE.match(raw)
        if not m:
            continue
        at, msg = m.groups()
        entries.append({"at": at, "msg": msg})
        # Scores: the start, dagger1, and each round.
        sm = re.match(r"\s*(ml/runs/\S+|dagger1|long-\d+): (-?\d+(?:\.\d+)?)", msg)
        if sm:
            name = sm.group(1).split("/")[-1]
            label, desc = describe(name)
            scores.append({"name": name, "label": label, "desc": desc, "score": float(sm.group(2)), "at": at, "best": "new best" in msg})
        if "-> new best" in msg and scores:
            scores[-1]["best"] = True
        if msg.startswith("DAgger"):
            step = {"kind": "dagger", "name": "dagger1", "hands": 8000, "since": at, "stage": "self-play"}
        rm = re.match(r"round (\d+): .* (\d+) hands", msg)
        if rm:
            step = {"kind": "round", "name": f"long-{rm.group(1)}", "hands": int(rm.group(2)), "since": at, "stage": "self-play"}
        if step and ("training" in msg or msg.strip() == "PPO"):
            step["stage"] = "training"
        if msg.startswith("scoring the start"):
            step = {"kind": "start", "name": "start", "hands": 0, "since": at, "stage": "scoring"}
    if step:
        d = os.path.join(ROOT, "ml/data", step["name"])
        step["chunksDone"] = len(glob.glob(os.path.join(d, "c*/manifest.json")))
        step["chunks"] = max(1, step["hands"] // 1000)
        step["chunkFails"] = sum(int(m.group(1)) for e in entries if e["at"] >= step["since"] for m in [re.search(r"retrying (\d+) crashed", e["msg"])] if m)
        if step["stage"] == "self-play" and step["chunksDone"] >= step["chunks"]:
            step["stage"] = "training"
        # Epochs finished so far, from the trainer's log.
        tl = os.path.join(ROOT, "ml/runs/long", f"{step['name']}-train.log")
        if step["stage"] == "training" and os.path.exists(tl):
            ep = re.findall(r"^epoch (\d+)/(\d+)\s+(\d+)s", open(tl).read(), re.M)
            if ep:
                step["epoch"], step["epochs"], step["epochSecs"] = map(int, ep[-1])
            else:
                step["epoch"], step["epochs"] = 0, None
        # Training writes the model before scoring it.
        if step["stage"] == "training" and os.path.exists(os.path.join(ROOT, "ml/runs", step["name"], "policy.onnx")):
            step["stage"] = "scoring"
    return entries, scores, step


def status():
    entries, scores, step = parse_log()
    started = entries[0]["at"] if entries else None
    st = read_state()
    if st.get("best"):
        st["bestLabel"], st["bestDesc"] = describe(st["best"].split("/")[-1])
    return {
        "run": run_state(),
        "state": st,
        "step": step,
        "scores": scores,
        "log": entries[-40:],
        "started": started,
        "load": os.getloadavg(),
        "cpus": os.cpu_count(),
        "backup": time.strftime("%m-%d %H:%M", time.localtime(os.path.getmtime(BACKUP))) if os.path.exists(BACKUP) else None,
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
        cmd = self.path.rsplit("/", 1)[-1]
        if not self.path.startswith("/ctl/") or cmd not in ("pause", "resume", "stop", "start"):
            return self.send(404, "not found", "text/plain")
        out = subprocess.run(["bash", "ml/ctl.sh", cmd, "perHand"], cwd=ROOT, capture_output=True, text=True)
        self.send(200, json.dumps({"out": (out.stdout + out.stderr).strip()}), "application/json")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"training dashboard on http://127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
