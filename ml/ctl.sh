#!/usr/bin/env bash
# Control the training runs:
#   perHand  - ml/long.sh: plays each hand for the most tai it can (no scoreboard)
#   matchDay - ml/matchday.sh: plays for the day's result - sees the scoreboard,
#              hands left, the goal dial and how each opponent has played
#
#   ml/ctl.sh start  perHand|matchDay [args]   in the background, kept awake
#   ml/ctl.sh pause  [perHand|matchDay]        freeze it where it is (no CPU, nothing lost) - both if not named
#   ml/ctl.sh resume [perHand|matchDay]
#   ml/ctl.sh stop   [perHand|matchDay]        end it; `start` again resumes from the last finished step
#   ml/ctl.sh status [perHand|matchDay]        running / paused, the best network, the latest log lines
set -uo pipefail
cd "$(dirname "$0")/.."

# perHand / matchDay, any case (v1 / v2 still work).
norm() { case "$(echo "$1" | tr '[:upper:]' '[:lower:]')" in matchday | v2) echo matchDay ;; *) echo perHand ;; esac; }
script() { [ "$1" = matchDay ] && echo ml/matchday.sh || echo ml/long.sh; }
logfile() { [ "$1" = matchDay ] && echo ml/runs/matchday.log || echo ml/runs/long.log; }
statefile() { [ "$1" = matchDay ] && echo ml/runs/matchday/state || echo ml/runs/long/state; }
# Every process a run has going: the script, and its self-play, arena,
# data and training processes (matchDay builds into .ml-md-*, trains ml/runs/matchday-*).
pattern() {
  if [ "$1" = matchDay ]; then echo 'ml/matchday\.sh|\.ml-md-|train\.py .*--out ml/runs/matchday-'
  else echo 'ml/long\.sh|\.ml-selfplay/|\.ml-eval/|train\.py .*--out ml/runs/(long-|dagger1)'; fi
}
pids() { pgrep -f "$(pattern "$1")"; }

cmd="${1:-status}"
shift || true
if [ "$cmd" = start ]; then
  run=$(norm "${1:-perHand}")
  shift || true
  if pgrep -f "$(script "$run")" >/dev/null; then echo "$run already running (ml/ctl.sh status $run)"; exit 1; fi
  # Starting again clears a health-check stop (see halt in the scripts).
  rm -f "$(dirname "$(statefile "$run")")/HALTED"
  nohup nice -n 10 caffeinate -i "$(script "$run")" "$@" >>"$(logfile "$run")" 2>&1 &
  echo "$run started - $(logfile "$run")"
  exit 0
fi
runs="${1:-perHand matchDay}"
for r in $runs; do
  run=$(norm "$r")
  case "$cmd" in
    pause) pids "$run" | xargs kill -STOP 2>/dev/null; echo "$run paused" ;;
    resume) pids "$run" | xargs kill -CONT 2>/dev/null; echo "$run resumed" ;;
    stop)
      pids "$run" | xargs kill -CONT 2>/dev/null
      pids "$run" | xargs kill -TERM 2>/dev/null
      echo "$run stopped"
      ;;
    status)
      p=$(pgrep -f "$(script "$run")" | head -1)
      if [ -z "$p" ]; then echo "$run: not running"
      elif ps -o stat= -p "$p" | grep -q T; then echo "$run: paused"
      else echo "$run: running"; fi
      [ -f "$(dirname "$(statefile "$run")")/HALTED" ] && echo "HALTED: $(cat "$(dirname "$(statefile "$run")")/HALTED")"
      [ -f "$(statefile "$run")" ] && cat "$(statefile "$run")"
      tail -n 6 "$(logfile "$run")" 2>/dev/null
      ;;
    *) echo "usage: ml/ctl.sh start|pause|resume|stop|status [perHand|matchDay]"; exit 1 ;;
  esac
done
