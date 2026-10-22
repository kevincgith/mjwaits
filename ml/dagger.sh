#!/usr/bin/env bash
# One DAgger round: the network plays (all four seats), the rule bot of each
# seat's style labels every decision, and a fresh network is trained on the
# original rule-bot data plus those corrections, then scored in the arena.
#
#   ml/dagger.sh <model> <name> [hands] [base-data]
#   ml/dagger.sh ml/runs/tile1 dagger1 8000 ml/data/run3
set -euo pipefail
cd "$(dirname "$0")/.."
model="$1"
name="$2"
hands="${3:-8000}"
base="${4:-ml/data/run3}"
echo "== $name from $model ($(date +%H:%M))"
npx vite build --ssr scripts/ml-selfplay.ts --outDir .ml-selfplay --emptyOutDir --logLevel warn
npx vite build --ssr scripts/ml-eval.ts --outDir .ml-eval --emptyOutDir --logLevel warn
node .ml-selfplay/ml-selfplay.js --model "$model" --hands "$hands" --session 16 --seed 211 --label teacher --out "ml/data/$name"
ml/.venv/bin/python -u ml/train.py --data "$base,ml/data/$name" --out "ml/runs/$name" --arch tile --width 256 --planes 20 --epochs 6 2>&1 | grep -v Warning
node .ml-eval/ml-eval.js --model "ml/runs/$name" --bots ml:grandmaster,grandmaster,basic,veteran --walls 512 --session 16 | tee "ml/runs/$name/arena.txt"
echo "== done ($(date +%H:%M))"
