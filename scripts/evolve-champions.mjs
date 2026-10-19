// node scripts/evolve-champions.mjs evolution/species1 [minHands=1000]
//
// Prints each species' current champion from an evolution log - its record
// and its settings as BotProfile fields - so they can be adopted into
// BOT_PROFILES in src/lib/bots.ts.

import { readFileSync } from "node:fs";

const log = JSON.parse(readFileSync(`${process.argv[2] ?? "evolution/species1"}/log.json`, "utf8"));
const last = log.generations[log.generations.length - 1];
const per = (s) => (s.taiWon - s.taiLost) / Math.max(1, s.hands);
const MIN_HANDS = Number(process.argv[3] ?? 1000);
console.log(`Generation ${last.gen}`);
for (const sp of log.config.species) {
  // The best net/hand among bots with at least MIN_HANDS played (a young
  // bot can top its species on a few hundred lucky hands); if none has
  // that many yet, the most experienced one.
  const mine = last.bots.filter((b) => b.species === sp.id);
  const proven = mine.filter((b) => b.life.hands >= MIN_HANDS);
  const champ = proven.length ? proven.sort((a, b) => per(b.life) - per(a.life))[0] : mine.sort((a, b) => b.life.hands - a.life.hands)[0];
  const l = champ.life;
  console.log(
    `\n${sp.name}: ${champ.name} (${champ.style}) born gen ${champ.born} - ${per(l).toFixed(2)}/hand over ${l.hands} hands, ` +
      `win ${((100 * l.wins) / l.hands).toFixed(1)}%, deal-in ${((100 * l.dealIns) / l.hands).toFixed(1)}%`
  );
  console.log(
    "  " +
      Object.entries(champ.genes)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")
  );
}
