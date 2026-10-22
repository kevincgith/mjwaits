#!/usr/bin/env bash
# Long unattended training, meant to run for days, paused and resumed at will
# (ml/ctl.sh pause | resume | stop | status).
#
#   ml/long.sh [start-model] [hands-per-round]
#   ml/long.sh ml/runs/tile1 32000
#
# 1. DAgger (once): the start network plays, the rule bots label every
#    decision, and a fresh network trains on the original rule-bot data plus
#    those corrections.
# 2. Self-play rounds, forever: the best network so far plays (two rule-bot
#    seats at every table), PPO learns from it, and the result is scored in
#    the arena (2,048 hands). It becomes the new best only if it scores
#    higher, so a bad round costs time, never strength.
#
# Everything is resumable: a stopped run picks up from ml/runs/long/state,
# and self-play chunks already written are kept. Models, logs and arena
# tables are copied to iCloud Drive after every step (ML_BACKUP to change).
set -uo pipefail
cd "$(dirname "$0")/.."
start="${1:-ml/runs/tile1}"
hands="${2:-32000}"
rules="grandmaster,veteran,gambler"
state=ml/runs/long/state
backup_dir="${ML_BACKUP:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/mjwaits-ml}"
mkdir -p ml/runs/long

log() { echo "[$(date '+%m-%d %H:%M')] $*"; }

backup() {
  mkdir -p "$backup_dir"
  rsync -a --include='*/' --include='*.onnx' --include='*.pt' --include='*.json' --include='*.txt' --include='*.log' --include='state' --exclude='*' ml/runs/ "$backup_dir/runs/"
}

# Self-play in chunks of 1,000 hands, each its own Node process (a long-lived
# one eventually crashes in the network runtime), retried if one dies.
# Prints the chunk directories, comma-separated, for train.py --data.
selfplay() {
  local out=$1 n=$2 seed=$3
  shift 3
  local chunk=1000 i=0 dirs=()
  mkdir -p "$out"
  while ((i * chunk < n)); do
    local d="$out/c$i"
    for try in 1 2 3; do
      [ -f "$d/manifest.json" ] && break
      node .ml-selfplay/ml-selfplay.js --hands "$chunk" --session 16 --seed "$((seed * 100 + i))" --out "$d" "$@" >/dev/null 2>"$out/c$i.err" || log "  chunk $i failed (try $try)" >&2
    done
    [ -f "$d/manifest.json" ] && dirs+=("$d")
    i=$((i + 1))
  done
  (IFS=,; echo "${dirs[*]}")
}

# The network's net tai per hand against the rule bots, over 2,048 hands.
score() {
  node .ml-eval/ml-eval.js --model "$1" --bots ml:grandmaster,grandmaster,basic,veteran --walls 512 --session 16 >"$1/arena.txt" 2>/dev/null
  awk '/\(net\)/ { for (i = 1; i <= NF; i++) if ($i == "(net)") print $(i + 1) }' "$1/arena.txt"
}

better() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a > b) }'; }

npx vite build --ssr scripts/ml-selfplay.ts --outDir .ml-selfplay --emptyOutDir --logLevel warn
npx vite build --ssr scripts/ml-eval.ts --outDir .ml-eval --emptyOutDir --logLevel warn

if [ -f "$state" ]; then
  # shellcheck disable=SC1090
  source "$state"
  log "resuming: best $best ($best_score), round $round"
else
  log "scoring the start, $start"
  best="$start"
  best_score=$(score "$start")
  round=0
  log "  $start: $best_score"
fi
save() { printf 'best=%q\nbest_score=%q\nround=%q\n' "$best" "$best_score" "$round" >"$state"; backup; }
save

if [ ! -f ml/runs/dagger1/policy.onnx ]; then
  log "DAgger: $best plays 8,000 hands, the rule bots label them"
  data=$(selfplay ml/data/dagger1 8000 211 --model "$best" --label teacher)
  log "  training on ml/data/run3 + the corrections"
  ml/.venv/bin/python -u ml/train.py --data "ml/data/run3,$data" --out ml/runs/dagger1 --arch tile --width 256 --planes 20 --epochs 6 2>&1 | grep -v Warning >ml/runs/long/dagger1-train.log
  s=$(score ml/runs/dagger1)
  log "  dagger1: $s (best so far $best_score)"
  if better "$s" "$best_score"; then best=ml/runs/dagger1; best_score=$s; log "  -> new best"; fi
  save
fi

while true; do
  round=$((round + 1))
  name="long-$round"
  log "round $round: $best self-play, $hands hands"
  data=$(selfplay "ml/data/$name" "$hands" "$((300 + round))" --model "$best" --rules "$rules")
  log "  PPO"
  ml/.venv/bin/python -u ml/train.py --rl --init "$best" --ref "$best" --data "$data" --out "ml/runs/$name" --lr 1e-4 --kl 0.2 2>&1 | grep -v Warning >"ml/runs/long/$name-train.log"
  rm -rf "ml/data/$name"
  if [ ! -f "ml/runs/$name/policy.onnx" ]; then
    log "  training failed - see ml/runs/long/$name-train.log"
    save
    continue
  fi
  s=$(score "ml/runs/$name")
  if better "$s" "$best_score"; then
    log "  $name: $s - new best (was $best_score)"
    best="ml/runs/$name"
    best_score=$s
  else
    log "  $name: $s - kept $best ($best_score)"
  fi
  save
done
