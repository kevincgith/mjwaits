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
# 2. Self-play rounds, forever: the best network so far plays (the two
#    other seats a rule bot or an earlier best, see league), PPO learns from it, and the result plays the
#    best head to head - both on the same fresh 8,192 arena hands. It
#    becomes the new best only if it scores higher there, so a bad round
#    costs time, never strength, and a lucky score can't set a bar nothing
#    clears (one 2,048-hand score can be off by 2-3 tai/hand).
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
# one eventually crashes in the network runtime), ML_PAR (4) at a time, and
# any that die are run again. Prints the chunk directories, comma-separated,
# for train.py --data.
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
      node .ml-selfplay/ml-selfplay.js --hands "$chunk" --session 16 --seed "$((seed * 100 + i))" --out "$out/c$i" "$@" >/dev/null 2>"$out/c$i.err" &
    done
    wait
  done
  for ((i = 0; i < count; i++)); do [ -f "$out/c$i/manifest.json" ] && dirs+=("$out/c$i"); done
  (IFS=,; echo "${dirs[*]}")
}

# The network's net tai per hand against the rule bots, over 2,048 hands.
score() {
  node .ml-eval/ml-eval.js --model "$1" --bots ml:grandmaster,grandmaster,basic,veteran --walls 512 --session 16 >"$1/arena.txt" 2>/dev/null
  awk '/\(net\)/ { for (i = 1; i <= NF; i++) if ($i == "(net)") print $(i + 1) }' "$1/arena.txt"
}

# Several networks on the same fresh 8,192 hands (4 sets of 512 walls, each
# its own seed), all side by side; each gets the merged table as
# <model>/arena.txt. Prints their net tai/hand, in order.
score_same() {
  local seed=$1 model k
  shift
  for model in "$@"; do
    for k in 0 1 2 3; do
      node .ml-eval/ml-eval.js --model "$model" --bots ml:grandmaster,grandmaster,basic,veteran --walls 512 --session 16 --seed "$((seed * 10 + k))" >"$model/arena-$seed-$k.txt" 2>/dev/null &
    done
  done
  wait
  for model in "$@"; do
    ml/.venv/bin/python ml/arena_merge.py "$model"/arena-"$seed"-?.txt >"$model/arena.txt"
    awk '/\(net\)/ { for (i = 1; i <= NF; i++) if ($i == "(net)") { printf "%s ", $(i + 1); exit } }' "$model/arena.txt"
  done
  echo
}

halt_file=ml/runs/long/HALTED
FLOOR=-8
# Stop the whole run, and say so (a Mac notification, the log, and a
# HALTED file the dashboard shows): a broken network or test should cost one
# round, not a night. `ml/ctl.sh start` clears it.
halt() {
  log "HALTED: $*"
  printf '%s\n' "$*" >"$halt_file"
  osascript -e "display notification \"$*\" with title \"MJWaits training stopped\" sound name \"Basso\"" >/dev/null 2>&1 || true
  save
  exit 1
}

# The network's win rate (%) in a scored model's arena table.
net_win() { awk '/\(net\)/ { for (i = 1; i <= NF; i++) if ($i == "(net)") { w = $(i + 2); sub("%", "", w); print w; exit } }' "$1/arena.txt" 2>/dev/null; }

# A scored network that looks broken stops the run: a healthy one wins
# ~22-25% of hands; under 10%, or a score past FLOOR, is a broken network
# (NaN weights once made one that never wins) or a broken test.
check_health() {
  local model=$1 score=$2 w
  w=$(net_win "$model")
  if [ -z "$w" ] || awk -v w="$w" 'BEGIN { exit !(w < 10) }'; then halt "$(basename "$model") won ${w:-?}% of its test hands - the network looks broken"; fi
  if awk -v s="$score" -v f="$FLOOR" 'BEGIN { exit !(s < f) }'; then halt "$(basename "$model") scored $score in its test - far outside the normal range"; fi
}

# Two failed rounds in a row (training or scoring) stop the run too.
fails=0
failed() {
  fails=$((fails + 1))
  [ "$fails" -ge 2 ] && halt "two rounds in a row failed: $*"
  return 0
}

# The league: up to four earlier bests, spread over the run's history (the
# first to the most recent, not the current best - it has the other two
# seats), for the opponent seats alongside the rule bots. The opposition
# then gets stronger as the network does.
league() {
  local ids=() id n i pick=()
  while read -r id; do
    [ "ml/runs/$id" != "$best" ] && [ -f "ml/runs/$id/policy.onnx" ] && ids+=("$id")
  done < <(grep -E "  long-[0-9]+: .* - new best" ml/runs/long.log | grep -oE "long-[0-9]+" | awk '!seen[$0]++')
  n=${#ids[@]}
  ((n)) || return 0
  for i in 0 1 2 3; do pick+=("ml/runs/${ids[$((i * (n - 1) / 3))]}"); done
  printf '%s\n' "${pick[@]}" | awk '!seen[$0]++' | paste -sd, -
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
save() { printf 'best=%q\nbest_score=%q\nround=%q\neval_v=%q\n' "$best" "$best_score" "$round" "${eval_v:-1}" >"$state"; backup; }
save

# Once, when moving to the head-to-head test: the networks so far that
# matter, on the same 8,192 hands, and the best of them becomes the best.
if [ "${eval_v:-1}" != 2 ] && [ -f ml/runs/dagger1/policy.onnx ]; then
  log "re-scoring on 8,192 hands, all on the same hands: tile1, dagger1, long-3"
  read -r a b c < <(score_same 900 ml/runs/tile1 ml/runs/dagger1 ml/runs/long-3)
  log "  tile1: $a"
  log "  dagger1: $b"
  log "  long-3: $c"
  best=ml/runs/tile1
  best_score=$a
  if better "$b" "$best_score"; then best=ml/runs/dagger1; best_score=$b; fi
  if better "$c" "$best_score"; then best=ml/runs/long-3; best_score=$c; fi
  log "  -> best on the bigger test: $best ($best_score)"
  eval_v=2
  save
fi

if [ ! -f ml/runs/dagger1/policy.onnx ]; then
  log "DAgger: $best plays 8,000 hands, the rule bots label them"
  data=$(selfplay ml/data/dagger1 8000 211 --model "$best" --label teacher)
  log "  training on ml/data/run3 + the corrections"
  ml/.venv/bin/python -u ml/train.py --data "ml/data/run3,$data" --out ml/runs/dagger1 --arch tile --width 256 --planes 20 --epochs 6 2>&1 | grep --line-buffered -v Warning >ml/runs/long/dagger1-train.log
  s=$(score ml/runs/dagger1)
  log "  dagger1: $s (best so far $best_score)"
  if better "$s" "$best_score"; then best=ml/runs/dagger1; best_score=$s; log "  -> new best"; fi
  save
fi

while true; do
  round=$((round + 1))
  name="long-$round"
  log "round $round: $best self-play, $hands hands"
  pool=$(league)
  [ -n "$pool" ] && log "  league: ${pool//ml\/runs\//}"
  data=$(selfplay "ml/data/$name" "$hands" "$((300 + round))" --model "$best" --rules "$rules" --temp 0.5 ${pool:+--league "$pool"})
  log "  PPO"
  ml/.venv/bin/python -u ml/train.py --rl --init "$best" --ref "$best" --data "$data" --out "ml/runs/$name" --lr 3e-5 --kl 1.0 --clip 0.1 2>&1 | grep --line-buffered -v Warning >"ml/runs/long/$name-train.log"
  rm -rf "ml/data/$name"
  if [ ! -f "ml/runs/$name/policy.onnx" ]; then
    log "  training failed - see ml/runs/long/$name-train.log"
    failed "training"
    save
    continue
  fi
  read -r s b < <(score_same "$((1000 + round))" "ml/runs/$name" "$best")
  # A missing score is a failed test, never a pass.
  if [ -z "$s" ] || [ -z "$b" ]; then
    log "  $name: scoring failed (round '${s:-none}', best '${b:-none}') - kept $best"
    failed "scoring"
    save
    continue
  fi
  check_health "$best" "$b"
  check_health "ml/runs/$name" "$s"
  fails=0
  if better "$s" "$b"; then
    log "  $name: $s vs best $b on the same 8,192 hands - new best"
    best="ml/runs/$name"
    best_score=$s
  else
    log "  $name: $s vs best $b on the same 8,192 hands - kept $best"
    best_score=$b
  fi
  save
done
