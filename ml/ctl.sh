#!/usr/bin/env bash
# Control the long training run (ml/long.sh).
#
#   ml/ctl.sh start [start-model] [hands]   in the background, kept awake, logged to ml/runs/long.log
#   ml/ctl.sh pause                         freeze it where it is (no CPU, nothing lost)
#   ml/ctl.sh resume                        carry on from exactly there
#   ml/ctl.sh stop                          end it; `start` again resumes from the last finished step
#   ml/ctl.sh status                        running / paused, the best network, the latest log lines
set -uo pipefail
cd "$(dirname "$0")/.."

pids() { pgrep -f "ml/long.sh|caffeinate -i ml/long.sh|ml-selfplay.js|ml-eval.js|ml/train.py"; }

case "${1:-status}" in
  start)
    if pgrep -f "ml/long.sh" >/dev/null; then echo "already running (ml/ctl.sh status)"; exit 1; fi
    shift
    nohup caffeinate -i ml/long.sh "$@" >>ml/runs/long.log 2>&1 &
    echo "started - ml/runs/long.log"
    ;;
  pause)
    pids | xargs kill -STOP 2>/dev/null
    echo "paused"
    ;;
  resume)
    pids | xargs kill -CONT 2>/dev/null
    echo "resumed"
    ;;
  stop)
    pids | xargs kill -CONT 2>/dev/null
    pids | xargs kill -TERM 2>/dev/null
    echo "stopped"
    ;;
  status)
    p=$(pgrep -f "ml/long.sh" | head -1)
    if [ -z "$p" ]; then echo "not running"
    elif ps -o stat= -p "$p" | grep -q T; then echo "paused"
    else echo "running"; fi
    [ -f ml/runs/long/state ] && cat ml/runs/long/state
    tail -n 8 ml/runs/long.log 2>/dev/null
    ;;
  *) echo "usage: ml/ctl.sh start|pause|resume|stop|status" ;;
esac
