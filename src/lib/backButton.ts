// Android's Back (the button, or the edge swipe): it closes what's open on
// top - a sheet, the More menu - or leaves the Play table, where it would
// otherwise take the whole app away. With nothing open it does what it
// always did (out of the app - on the second press, in the installed app).
//
// The page keeps one extra entry in its history to catch the press; each
// time it's used for something, it's put back. Android only: an iPhone's
// installed app has no Back, and in a browser there the swipe back should
// leave the page as it always has.
//
// What's on top is found on the page as it stands, not registered sheet by
// sheet: a backdrop that closes its sheet when tapped is tapped; failing
// that, a sheet's own Close; failing that, the table's Leave.

const CLOSES_ON_TAP = ".sc-backdrop:not(.is-parked), .sheet-backdrop, .play-sheet-backdrop, .tab-more-backdrop";
const CLOSE_BUTTONS = '.play-setup-backdrop button[aria-label="Close"], .seat-rename-backdrop button[aria-label="Close"], [role="dialog"] button[aria-label="Close"]';
const LEAVE_BUTTONS = 'button[aria-label="Leave the table"], button[aria-label="Leave Play"]';

const shown = (el: HTMLElement) => el.getClientRects().length > 0;

// Closes the topmost thing that's open; false if nothing is.
export function closeTopmost(doc: Document = document): boolean {
  for (const selector of [CLOSES_ON_TAP, CLOSE_BUTTONS, LEAVE_BUTTONS]) {
    // (The last in the page is the one on top: sheets open over what opened them.)
    const top = [...doc.querySelectorAll<HTMLElement>(selector)].filter(shown).at(-1);
    if (top) {
      top.click();
      return true;
    }
  }
  return false;
}

export function installBackButton(): void {
  if (typeof window === "undefined" || !/Android/i.test(navigator.userAgent)) return;
  // The entry under the catch one is where a Back press lands: known by its
  // address, as it was when the catch entry was put over it. (The app may
  // rewrite the address of the entry it's on - dropping a link's # once it's
  // read - but that's the catch entry's, not the one under it.)
  let under = "";
  const arm = () => {
    under = window.location.href;
    window.history.pushState({ mjwaitsBack: true }, "");
  };
  // (The page reloaded on its catch entry - an entry keeps its state through
  // a reload: it's there already, over the same address.)
  if ((window.history.state as { mjwaitsBack?: boolean } | null)?.mjwaitsBack) under = window.location.href;
  else arm();
  window.addEventListener("popstate", (e) => {
    // Back on the catch entry itself (from a link opened over it): armed still.
    if ((e.state as { mjwaitsBack?: boolean } | null)?.mjwaitsBack) return;
    // Anywhere but the entry under it: a link's fragment (a shared hand or
    // scores opened while the app's up - see App's hashchange), not Back.
    if (window.location.href !== under) return;
    if (closeTopmost()) arm();
    // Nothing to close: on, to wherever Back was going (in the installed
    // app there's nowhere - the next press leaves it).
    else window.history.back();
  });
}
