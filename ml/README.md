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

### Two runs: perHand and matchDay

- **perHand** (`ml/long.sh`, encoding v1): plays each hand for the most tai.
  It never sees the scoreboard.
- **matchDay** (`ml/matchday.sh`, encoding v2): plays for the day's result.
  On top of the hand it sees the match context (`src/lib/ml/match.ts`): its
  total and the gaps to the others, its place, hands left in a 60-100-hand day,
  each opponent's record so far (win, deal-in, call, 叮 and big-win rates, average
  win), and a **goal dial** - 0 is pure tai, 1 makes placing count most (finishing
  1st is worth +300 on top of the tai, 4th −300). Training plays every setting,
  so one network can be asked for any of them.
  - Half its match days start part-way, with a random scoreboard, so late,
    lopsided days come up often.
  - Its reward is how much a hand moved the expected end of the day: a small
    board-value network (`train.py`, Suphx's "global reward prediction") learns
    what a scoreboard is worth from finished matches. A late deal-in while
    leading then costs what it really costs.
  - It's scored on 64-hand match days at goal 0.5 (utility per hand), and
    `ml-eval --match <hands> --goal <g>` reports 1st-place rates for any network.

`ml/ctl.sh start|pause|resume|stop|status [perHand|matchDay]` controls either
(both when not named).

### The long run

```bash
ml/ctl.sh start ml/runs/tile1 32000   # in the background, kept awake
ml/ctl.sh pause                       # freeze where it is - no CPU, nothing lost
ml/ctl.sh resume
ml/ctl.sh stop                        # start again later resumes from the last finished step
ml/ctl.sh status
```

`python3 ml/dashboard.py` serves a live dashboard for both runs on http://127.0.0.1:8765:
what it's doing now and how far through, every step's arena score against
the best so far, the log, and Pause / Resume buttons.

`ml/long.sh` does one DAgger round (the network plays, the rule bots label
its positions, a fresh network trains on both), then self-play rounds
forever: PPO on 32,000 hands of the best network so far, scored over 2,048
arena hands, kept only if it beats the best. Self-play runs in 1,000-hand
chunks, each its own Node process, retried if one crashes. The log is
`ml/runs/long.log`; models, logs and arena tables are copied to iCloud Drive
(`mjwaits-ml/`) after every step.

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
4. **Human data.** Switch on **Record my play** in the Play menu: your
   decisions are kept in the browser (IndexedDB, nothing leaves the device)
   in the same encoding, with each hand's outcome. **Export my play for
   training** saves a `.jsonl`; `ml/.venv/bin/python ml/human.py <files> --out
   ml/data/human1` turns it into shards with one style, `human`, to learn or
   fine-tune toward - the most human-like personality there can be.
5. **In the app.** The ONNX model (a few MB) runs in the browser through
   onnxruntime-web, as new opponents in the Opponents sheet.

## Why the GPU now

The game engine and the rule bots are branchy logic that runs best on CPU
cores (the arena and the evolution use all of them). Neural networks are the
opposite - big batches of identical arithmetic - so training runs on the M2's
GPU through PyTorch's Metal (MPS) backend.
