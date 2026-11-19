// Android's Back (the button, or the edge swipe): it closes what's open on
// top - a sheet, the More menu, the chat - or leaves the Play table, where
// it would otherwise take the whole app away. With nothing open it does
// what it always did (out of the app - on the second press, in the
// installed app).
//
// The page keeps two entries in its history: the one it was opened on (the
// base) and one over it (the catch), where it rests. A Back press lands on
// the base; whatever's on top is closed, and the catch put back. Android
// only: an iPhone's installed app has no Back, and in a browser there the
// swipe back should leave the page as it always has.
//
// What's on top: anything that says so itself (useBackClose - the overlays
// that aren't plain sheets), and, for the plain sheets, what's found on the
// page - a backdrop that closes its sheet when tapped is tapped; a sheet's
// own Close; the table's Leave. In that order: what sits over the sheets
// (a rename box, the rules reference, the scan's crop), the sheets, then
// what the sheets open over (the chat, a hand's result, the setup page, a
// lobby), then leaving the table.
//
// The app's own changes to the address (a link's ?h= or # dropped once it's
// read) go through rewriteAddress, on any phone: it keeps the entry's mark,
// and the address the catch entry is put back with - so a link that's been
// read and dropped isn't brought back by a Back press landing on the base
// (whose own address is cleaned then too).

import { useEffect, useRef } from "react";

type Level = "over" | "under";
interface Open {
  close: () => void;
  level: Level;
}
// What's said it's open, oldest first.
const open: Open[] = [];

// While `close` is given: Back calls it (see the order above). `level`:
// "over" the plain sheets, or "under" them.
export function useBackClose(close: (() => void) | null | false | undefined, level: Level = "under"): void {
  const latest = useRef(close);
  latest.current = close;
  const active = !!close;
  useEffect(() => {
    if (!active) return;
    const entry: Open = { close: () => latest.current && latest.current(), level };
    open.push(entry);
    return () => {
      const i = open.indexOf(entry);
      if (i >= 0) open.splice(i, 1);
    };
  }, [active, level]);
}

const CLOSES_ON_TAP = ".sc-backdrop:not(.is-parked), .sheet-backdrop, .play-sheet-backdrop, .tab-more-backdrop";
const CLOSE_BUTTONS = '[role="dialog"] button[aria-label="Close"]';
const LEAVE_BUTTONS = 'button[aria-label="Leave the table"], button[aria-label="Leave Play"]';

const shown = (el: HTMLElement) => el.getClientRects().length > 0;
// (The last in the page is the one on top: sheets open over what opened them.)
function tapTop(doc: Document, selector: string): boolean {
  const top = [...doc.querySelectorAll<HTMLElement>(selector)].filter(shown).at(-1);
  top?.click();
  return !!top;
}
function closeSaid(level: Level): boolean {
  const top = open.filter((o) => o.level === level).at(-1);
  top?.close();
  return !!top;
}

// Closes the topmost thing that's open; false if nothing is.
// (An overlay's own way out, marked on its button - data-back-close="over"
// for one over the sheets, data-back-close for one under them: the same as
// saying so through useBackClose, for where there's just a button to tap.)
export function closeTopmost(doc: Document = document): boolean {
  return (
    closeSaid("over") ||
    tapTop(doc, '[data-back-close="over"]') ||
    tapTop(doc, CLOSES_ON_TAP) ||
    tapTop(doc, CLOSE_BUTTONS) ||
    closeSaid("under") ||
    tapTop(doc, '[data-back-close]:not([data-back-close="over"])') ||
    tapTop(doc, LEAVE_BUTTONS)
  );
}

type Mark = { mjwaitsBack?: boolean; mjwaitsBase?: boolean } | null;
const mark = (): Mark => (typeof window === "undefined" ? null : (window.history.state as Mark));

// The app's address, changed in place (no new history entry) - keeping the
// entry's mark, which a bare replaceState(null, …) would wipe.
export function rewriteAddress(url: string): void {
  window.history.replaceState(window.history.state, "", url);
}

export function installBackButton(): void {
  if (typeof window === "undefined" || !/Android/i.test(navigator.userAgent)) return;
  const arm = () => window.history.pushState({ mjwaitsBack: true }, "");
  // (A reload keeps the entry's mark: on the catch entry, all's in place.)
  if (!mark()?.mjwaitsBack) {
    if (!mark()?.mjwaitsBase) window.history.replaceState({ mjwaitsBase: true }, "");
    arm();
  }
  // The address the app's on, as last seen on the catch entry: what the
  // base is given when a Back press lands on it.
  let address = window.location.href;
  const note = () => {
    if (mark()?.mjwaitsBack) address = window.location.href;
  };
  // (rewriteAddress, and a link's # opened over the app, both change it.)
  const replace = window.history.replaceState.bind(window.history);
  window.history.replaceState = (...args) => {
    replace(...args);
    note();
  };
  window.addEventListener("hashchange", note);
  window.addEventListener("popstate", (e) => {
    const state = e.state as Mark;
    // Back onto the catch entry itself (from a link opened over it), or a
    // link's # opened over the app: not a Back press to act on.
    if (!state?.mjwaitsBase) return void note();
    // On the base: its address is whatever the app was opened with - a link
    // long since read and dropped. Given the app's address now, so neither
    // this landing nor a reload reads that link again.
    if (window.location.href !== address) replace({ mjwaitsBase: true }, "", address);
    if (closeTopmost()) return arm();
    // Nothing to close: on, to wherever Back was going. In the installed
    // app there's nowhere - a second press, soon after, leaves it; left
    // alone, the catch goes back, so Back closes things again.
    window.history.back();
    window.setTimeout(() => mark()?.mjwaitsBase && arm(), 2000);
  });
}
