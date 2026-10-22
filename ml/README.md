# Learned bots

Groundwork for mahjong bots that learn from play instead of hand-written rules,
each with its own personality.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| Encoder | `src/lib/ml/encode.ts` | What one seat can see at a decision, as `OBS_SIZE` small integers, and every move as one of `NUM_ACTIONS` indices (discard, discard + 叮, 自摸, kong, pass, win, pung, kong, 3 chows) with a legal-action mask. Shared by data, training and play, so they can't drift. Tested to round-trip every bot decision. |
| Recorder | `scripts/ml-data.ts` (`npm run ml-data`) | Bots of every personality play 16-hand sessions (拉, dealer, 連莊 carried; 投降 between hands). Every real decision is saved: observation, legal mask, chosen action, the bot's personality, and how the hand and the session went for that seat. |
| Trainer | `ml/train.py` | One network for every personality: a style embedding goes in with the position. A policy head (masked move logits) and a value head (the hand's net for the deciding seat). Trains on the Apple GPU (MPS), exports ONNX. |
| Player | `src/lib/ml/policy.ts` | Turns the network's output back into a move or claim; the runtime is passed in (onnxruntime-web in the browser, its WASM build in Node). |
| Evaluator | `scripts/ml-eval.ts` (`npm run ml-eval`) | The network (as `ml:<style>`) against rule bots in the arena's duplicate format. |

## Setup

```bash
python3 -m venv ml/.venv
ml/.venv/bin/pip install torch numpy onnx onnxscript
```

## Run

```bash
npm run ml-data -- --hands 12000 --session 16 --out ml/data/run1
ml/.venv/bin/python ml/train.py --data ml/data/run1 --out ml/runs/bc1 --epochs 6
npm run ml-eval -- --model ml/runs/bc1 --bots ml:grandmaster,grandmaster,basic,gambler --walls 64
```

Data, environments and model runs are git-ignored (`ml/data`, `ml/.venv`,
`ml/runs`); they're regenerated from the commands above.

## The plan

1. **Behaviour cloning (now).** The network imitates the evolved rule bots, one
   style id per personality. This proves the pipeline end to end and gives a
   starting point that already plays sensibly - training from random play
   would waste most of the compute.
2. **Self-play reinforcement learning.** Start from the cloned network and
   improve it by playing itself, rewarded by tai won. The value head gives
   the baseline (advantage = result - predicted). A KL penalty toward the
   cloned policy keeps each personality recognisable while it gets stronger.
3. **Personalities by reward, not rules.** Each style's reward is shaped to its
   character: the Hunter weights big hands up, the Iron Wall pays extra for
   every deal-in, the Speedster is rewarded for winning early, the Gambler
   ignores risk. The network learns *how* to play that way, rather than
   following a tuned formula.
4. **Human data.** Record your own games at the table (the same encoder) and
   fine-tune toward them - the most human-like personality there can be.
5. **In the app.** The ONNX model (a few MB) runs in the browser through
   onnxruntime-web, as new opponents in the Opponents sheet.

## Why the GPU now

The game engine and the rule bots are branchy logic that runs best on CPU
cores (the arena and the evolution use all of them). Neural networks are the
opposite - big batches of identical arithmetic - so training runs on the M2's
GPU through PyTorch's Metal (MPS) backend.
