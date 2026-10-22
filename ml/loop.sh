#!/usr/bin/env bash
# Self-play improvement loop (stage 2). Each round: the current network plays
# itself, PPO learns from those hands, and the result plays the rule bots in
# the arena so every round's strength is on record.
#
#   ml/loop.sh <start-run> <rounds> [hands-per-round]
#   ml/loop.sh ml/runs/tile1 3 4000
#
# Rounds are written to ml/runs/rl-<n>, data to ml/data/sp-<n>, and each
# arena table to ml/runs/rl-<n>/arena.txt.
set -euo pipefail
cd "$(dirname "$0")/.."
model="$1"
rounds="$2"
hands="${3:-4000}"
npx vite build --ssr scripts/ml-selfplay.ts --outDir .ml-selfplay --emptyOutDir --logLevel warn
npx vite build --ssr scripts/ml-eval.ts --outDir .ml-eval --emptyOutDir --logLevel warn
for n in $(seq 1 "$rounds"); do
  echo "== round $n from $model ($(date +%H:%M))"
  node .ml-selfplay/ml-selfplay.js --model "$model" --hands "$hands" --session 16 --seed "$((100 + n))" --out "ml/data/sp-$n"
  ml/.venv/bin/python -u ml/train.py --rl --init "$model" --data "ml/data/sp-$n" --out "ml/runs/rl-$n" 2>&1 | grep -v Warning
  node .ml-eval/ml-eval.js --model "ml/runs/rl-$n" --bots ml:grandmaster,grandmaster,basic,veteran --walls 64 --session 16 | tee "ml/runs/rl-$n/arena.txt"
  model="ml/runs/rl-$n"
done
echo "== done ($(date +%H:%M))"
