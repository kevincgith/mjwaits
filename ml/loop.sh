#!/usr/bin/env bash
# Self-play improvement loop (stage 2). Each round: the current network plays
# itself, PPO learns from those hands, and the result plays the rule bots in
# the arena so every round's strength is on record.
#
#   ml/loop.sh <start-run> <rounds> [hands-per-round] [rule-bots] [name]
#   ml/loop.sh ml/runs/tile1 3 8000 grandmaster,veteran,gambler rl2
#
# Every round stays anchored (KL) to <start-run>, and with rule-bots given
# they fill two seats at every self-play table.
#
# Rounds are written to ml/runs/<name>-<n> (name defaults to rl), data to
# ml/data/<name>-sp-<n>, and each arena table to ml/runs/<name>-<n>/arena.txt.
set -euo pipefail
cd "$(dirname "$0")/.."
model="$1"
rounds="$2"
hands="${3:-4000}"
rules="${4:-}"
name="${5:-rl}"
start="$model"
npx vite build --ssr scripts/ml-selfplay.ts --outDir .ml-selfplay --emptyOutDir --logLevel warn
npx vite build --ssr scripts/ml-eval.ts --outDir .ml-eval --emptyOutDir --logLevel warn
for n in $(seq 1 "$rounds"); do
  echo "== round $n from $model ($(date +%H:%M))"
  node .ml-selfplay/ml-selfplay.js --model "$model" --hands "$hands" --session 16 --seed "$((100 + n))" --out "ml/data/$name-sp-$n" ${rules:+--rules "$rules"}
  ml/.venv/bin/python -u ml/train.py --rl --init "$model" --ref "$start" --data "ml/data/$name-sp-$n" --out "ml/runs/$name-$n" ${RL_ARGS:-} 2>&1 | grep -v Warning
  node .ml-eval/ml-eval.js --model "ml/runs/$name-$n" --bots ml:grandmaster,grandmaster,basic,veteran --walls 128 --session 16 | tee "ml/runs/$name-$n/arena.txt"
  model="ml/runs/$name-$n"
done
echo "== done ($(date +%H:%M))"
