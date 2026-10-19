// node scripts/evolve-champions.mjs evolution/species1
//
// Prints each species' current champion from an evolution log - its record
// and its settings as BotProfile fields - so they can be adopted into
// BOT_PROFILES in src/lib/bots.ts.

import { readFileSync } from "node:fs";

const log = JSON.parse(readFileSync(`${process.argv[2] ?? "evolution/species1"}/log.json`, "utf8"));
const last = log.generations[log.generations.length - 1];
const per = (s) => (s.taiWon - s.taiLost) / Math.max(1, s.hands);
console.log(`Generation ${last.gen}`);
for (const sp of log.config.species) {
  const champ = last.bots.filter((b) => b.species === sp.id).sort((a, b) => b.score - a.score)[0];
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
