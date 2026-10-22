// npm run ml-eval -- --model ml/runs/bc1 [--bots ml:veteran,veteran,basic,gambler] [--walls 64] [--session 16] [--temp 0]
//
// Plays a trained network (ml/train.py) against the rule bots in the arena's
// duplicate format - each session dealt four times with the bots rotated a
// seat - and prints the usual table. "ml:<style>" seats are the network
// playing as that personality; anything else is a rule bot (or "basic").
// Runs on one thread (the network's runtime is async and single-session).

import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web/wasm";
import { BASELINE, emptyStats, formatArena, type ArenaResult, type BotStats } from "../src/lib/arena";
import { botClaimFor, botSurrenders, botTurnMoveFor, profileById, seededRng, type BotProfile, type Rng } from "../src/lib/bots";
import { applyTurnMove, botClaim, botTurnMove, dealHand, fullWall, nextHand, resolveClaims, SEATS, surrender, type Claim, type GameState, type TurnMove, type WallTile } from "../src/lib/game";
import { NUM_ACTIONS, OBS_SIZE } from "../src/lib/ml/encode";
import { learnedClaim, learnedTurnMove, type LearnedBot } from "../src/lib/ml/policy";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const modelDir = opt("model", "ml/runs/bc1");
const ids = opt("bots", "ml:veteran,veteran,basic,gambler").split(",");
const walls = Number(opt("walls", "64"));
const session = Number(opt("session", "16"));
const temperature = Number(opt("temp", "0"));
const seed = Number(opt("seed", "1"));

const meta = JSON.parse(readFileSync(`${modelDir}/meta.json`, "utf8")) as { styles: string[]; obsSize: number; numActions: number };
if (meta.obsSize !== OBS_SIZE || meta.numActions !== NUM_ACTIONS) throw new Error("Model was trained on a different encoding");
ort.env.wasm.numThreads = 1;
const net = await ort.InferenceSession.create(readFileSync(`${modelDir}/policy.onnx`));
const run = async (obs: Float32Array, style: number, mask: Float32Array) => {
  const out = await net.run({
    obs: new ort.Tensor("float32", obs, [1, OBS_SIZE]),
    style: new ort.Tensor("int64", BigInt64Array.from([BigInt(style)]), [1]),
    mask: new ort.Tensor("float32", mask, [1, NUM_ACTIONS]),
  });
  return { logits: out.logits.data as Float32Array, value: (out.value.data as Float32Array)[0] };
};

type Seat = { kind: "ml"; bot: LearnedBot; profile: BotProfile } | { kind: "rule"; profile: BotProfile };
const seatsSpec: Seat[] = ids.map((id) => {
  if (id.startsWith("ml:")) {
    const style = meta.styles.indexOf(id.slice(3));
    if (style < 0) throw new Error(`Unknown style ${id}; the model knows ${meta.styles.join(", ")}`);
    const base = profileById(id.slice(3));
    return { kind: "ml", bot: { run, style, temperature }, profile: { ...base, id, name: `學 ${base.name.split(" ").slice(1).join(" ")} (net)` } };
  }
  return { kind: "rule", profile: id === "basic" ? BASELINE : profileById(id) };
});

const turnMove = async (seat: Seat, s: GameState, rng: Rng): Promise<TurnMove> =>
  seat.kind === "ml" ? learnedTurnMove(seat.bot, s, rng) : seat.profile.id === "basic" ? botTurnMove(s) : botTurnMoveFor(s, seat.profile, rng);
const claim = async (seat: Seat, s: GameState, i: number, rng: Rng): Promise<Claim | null> =>
  seat.kind === "ml" ? learnedClaim(seat.bot, s, i, rng) : seat.profile.id === "basic" ? botClaim(s, i) : botClaimFor(s, i, seat.profile, rng);

function shuffledWall(rng: Rng): WallTile[] {
  const w = fullWall();
  for (let i = w.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [w[i], w[j]] = [w[j], w[i]];
  }
  return w;
}

const t0 = Date.now();
const rng = seededRng(seed);
const stats: BotStats[] = seatsSpec.map((s) => emptyStats(s.profile));
let hands = 0;
let draws = 0;
for (let w = 0; w < walls; w += session) {
  const sessionWalls = Array.from({ length: Math.min(session, walls - w) }, () => shuffledWall(rng));
  for (let rot = 0; rot < SEATS; rot++) {
    const at = (seat: number) => (seat - rot + SEATS) % SEATS;
    const seats = Array.from({ length: SEATS }, (_, seat) => seatsSpec[at(seat)]);
    let s: GameState = dealHand({ dealer: (w / session) % SEATS, roundWind: 1, dealerStreak: 0 }, sessionWalls[0].slice());
    for (let h = 0; h < sessionWalls.length; h++) {
      for (let steps = 0; s.phase.kind !== "over" && steps < 2000; steps++) {
        if (s.phase.kind === "turn") s = applyTurnMove(s, await turnMove(seats[s.phase.seat], s, rng));
        else {
          const decisions: (Claim | null)[] = [];
          for (let i = 0; i < SEATS; i++) decisions.push(await claim(seats[i], s, i, rng));
          s = resolveClaims(s, decisions);
        }
      }
      hands++;
      if (s.phase.kind !== "over") break;
      const r = s.phase.result;
      for (let seat = 0; seat < SEATS; seat++) {
        const st = stats[at(seat)];
        st.hands++;
        if (r.deltas[seat] > 0) st.taiWon += r.deltas[seat];
        if (r.deltas[seat] < 0) st.taiLost -= r.deltas[seat];
        if (s.players[seat].riichi) st.riichis++;
      }
      if (r.winner === null) draws++;
      else {
        stats[at(r.winner)].wins++;
        if (r.from === null) stats[at(r.winner)].selfDraws++;
        stats[at(r.winner)].biggestWin = Math.max(stats[at(r.winner)].biggestWin, r.score?.total ?? 0);
        if (r.from !== null) {
          stats[at(r.from)].dealIns++;
          stats[at(r.from)].dealInTai -= r.deltas[r.from];
        }
      }
      if (h === sessionWalls.length - 1) break;
      for (let seat = 0; seat < SEATS; seat++) {
        const p = seats[seat].profile;
        if (seats[seat].kind === "rule") for (const holder of botSurrenders(s, seat, p)) s = surrender(s, holder, seat);
      }
      s = nextHand(s, sessionWalls[h + 1].slice());
    }
  }
}
const result: ArenaResult = { hands, draws, stats, ms: Date.now() - t0 };
console.log(formatArena(result));
