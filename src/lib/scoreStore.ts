// Where the Scores tab keeps its store on this device (localStorage). The
// store itself - its shape, normalizing, backups - is the shared ledger's;
// only this part needs a browser.

import { emptyStore, normalizeStore, type ScoreStore } from "@mjwaits/shared/engine/ledger";

export const SCORES_KEY = "mjwaits.scores";

// Saved scores that couldn't be read are copied here before anything new is
// saved over them, so they're never lost - a backup file can still be made
// from them (see unreadableScores).
export const UNREADABLE_SCORES_KEY = `${SCORES_KEY}.unreadable`;

export function loadScores(): ScoreStore {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SCORES_KEY);
    if (!raw) return emptyStore();
    return normalizeStore(JSON.parse(raw) as Partial<ScoreStore>);
  } catch {
    if (raw) {
      try {
        window.localStorage.setItem(UNREADABLE_SCORES_KEY, raw);
      } catch {
        // No room even for that - the next save would still overwrite it.
      }
    }
    return emptyStore();
  }
}

// The saved scores that couldn't be read, if any were kept.
export function unreadableScores(): string | null {
  try {
    return window.localStorage.getItem(UNREADABLE_SCORES_KEY);
  } catch {
    return null;
  }
}

// false: the scores weren't saved (storage full or blocked) - they'd be lost
// on a reload, so the Scores tab says so.
export function saveScores(store: ScoreStore): boolean {
  try {
    window.localStorage.setItem(SCORES_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}
