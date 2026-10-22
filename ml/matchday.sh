#!/usr/bin/env bash
# The match-day learned bot (encoding v2): sees the scoreboard, how much of
# the day is left, the goal dial and how each opponent has played, and is
# trained toward the day's outcome rather than each hand's tai. Runs for
# days; resumable; controlled with ml/ctl.sh <cmd> matchDay.
#
#   ml/matchday.sh [hands-per-round]
#
# 1. Rule-bot match days (20,000 hands) -> copy them        (matchday-copy)
# 2. DAgger: matchday-copy plays, the rule bots label             (matchday-corrected)
# 3. Self-play rounds forever, rewarded by how much each hand moved the
#    expected end of the day (train.py's board value), each kept only if it
#    beats the best on 64-hand match days at goal 0.5 (utility per hand).
#
# Its own build folders (.ml-md-*), data (ml/data/matchday-*), runs (ml/runs/matchday-*)
# and state (ml/runs/matchday/state), so the perHand run (ml/long.sh) is untouched.
# Backed up to iCloud Drive after every step, like v1.
set -uo pipefail
cd "$(dirname "$0")/.."
hands="${1:-32000}"
rules="grandmaster,veteran,gambler"
state=ml/runs/matchday/state
backup_dir="${ML_BACKUP:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/mjwaits-ml}"
mkdir -p ml/runs/matchday

log() { echo "[$(date '+%m-%d %H:%M')] $*"; }

backup() {
  mkdir -p "$backup_dir"
  rsync -a --include='*/' --include='*.onnx' --include='*.pt' --include='*.json' --include='*.txt' --include='*.log' --include='state' --exclude='*' ml/runs/ "$backup_dir/runs/"
}

# As ml/long.sh: 1,000-hand chunks in separate processes, ML_PAR at a time,
# crashed ones run again.
selfplay() {
  local out=$1 n=$2 seed=$3
  shift 3
  local chunk=1000 count=$(((n + 999) / 1000)) par="${ML_PAR:-4}" dirs=() todo i
  mkdir -p "$out"
  for try in 1 2 3; do
    todo=()
    for ((i = 0; i < count; i++)); do [ -f "$out/c$i/manifest.json" ] || todo+=("$i"); done
    ((${#todo[@]})) || break
    ((try > 1)) && log "  retrying ${#todo[@]} crashed chunk(s)" >&2
    for i in "${todo[@]}"; do
      while (($(jobs -rp | wc -l) >= par)); do sleep 2; done
      node .ml-md-selfplay/ml-selfplay.js --hands "$chunk" --session 16 --seed "$((seed * 100 + i))" --out "$out/c$i" "$@" >/dev/null 2>"$out/c$i.err" &
    done
    wait
  done
  for ((i = 0; i < count; i++)); do [ -f "$out/c$i/manifest.json" ] && dirs+=("$out/c$i"); done
  (IFS=,; echo "${dirs[*]}")
}

# Utility per hand on 64-hand match days at goal 0.5 (2,048 hands), against
# the same rule bots as v1. The full table (tai, wins, places) is kept.
score() {
  node .ml-md-eval/ml-eval.js --model "$1" --bots ml:grandmaster,grandmaster,basic,veteran --walls 512 --match 64 --goal 0.5 >"$1/arena.txt" 2>/dev/null
  awk '/Utility\/day/ { on = 1; next } on && /\(net\)/ { print $NF / 64; exit }' "$1/arena.txt"
}

better() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a > b) }'; }

npx vite build --ssr scripts/ml-data.ts --outDir .ml-md-data --emptyOutDir --logLevel warn
npx vite build --ssr scripts/ml-selfplay.ts --outDir .ml-md-selfplay --emptyOutDir --logLevel warn
npx vite build --ssr scripts/ml-eval.ts --outDir .ml-md-eval --emptyOutDir --logLevel warn

best=""
best_score=-999
round=0
# shellcheck disable=SC1090
[ -f "$state" ] && source "$state" && log "resuming: best ${best:-none} ($best_score), round $round"
save() { printf 'best=%q\nbest_score=%q\nround=%q\n' "$best" "$best_score" "$round" >"$state"; backup; }

if [ ! -f ml/data/matchday-rules/manifest.json ]; then
  log "matchDay data: rule bots play 20,000 hands of match days"
  node .ml-md-data/ml-data.js --hands 20000 --seed 7 --out ml/data/matchday-rules --match | tail -1
fi

if [ ! -f ml/runs/matchday-copy/policy.onnx ]; then
  log "matchDay copy: learning the rule bots' play, with the match inputs"
  ml/.venv/bin/python -u ml/train.py --data ml/data/matchday-rules --out ml/runs/matchday-copy --arch tile --width 256 --planes 20 --epochs 6 2>&1 | grep --line-buffered -v Warning >ml/runs/matchday/matchday-copy-train.log
  s=$(score ml/runs/matchday-copy)
  log "  matchday-copy: $s"
  best=ml/runs/matchday-copy
  best_score=$s
  save
fi

if [ ! -f ml/runs/matchday-corrected/policy.onnx ]; then
  log "matchDay DAgger: matchday-copy plays 8,000 hands of match days, the rule bots label them"
  data=$(selfplay ml/data/matchday-dagger 8000 411 --model ml/runs/matchday-copy --label teacher)
  log "  training on the rule-bot match days + the corrections"
  ml/.venv/bin/python -u ml/train.py --data "ml/data/matchday-rules,$data" --out ml/runs/matchday-corrected --arch tile --width 256 --planes 20 --epochs 6 2>&1 | grep --line-buffered -v Warning >ml/runs/matchday/matchday-corrected-train.log
  s=$(score ml/runs/matchday-corrected)
  log "  matchday-corrected: $s (best so far $best_score)"
  if better "$s" "$best_score"; then best=ml/runs/matchday-corrected; best_score=$s; log "  -> new best"; fi
  save
fi

while true; do
  round=$((round + 1))
  name="matchday-round-$round"
  log "matchDay round $round: $best self-play match days, $hands hands"
  data=$(selfplay "ml/data/$name" "$hands" "$((500 + round))" --model "$best" --rules "$rules")
  log "  PPO (rewarded by the day's outcome)"
  ml/.venv/bin/python -u ml/train.py --rl --init "$best" --ref "$best" --data "$data" --out "ml/runs/$name" --lr 1e-4 --kl 0.2 2>&1 | grep --line-buffered -v Warning >"ml/runs/matchday/$name-train.log"
  rm -rf "ml/data/$name"
  if [ ! -f "ml/runs/$name/policy.onnx" ]; then
    log "  training failed - see ml/runs/matchday/$name-train.log"
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
