// Play behaves like a game on a phone, not a web page: no zooming (pinch,
// double tap, or a field's focus), no pull-to-refresh or rubber-banding, no
// long-press menus or selection - and all of it undone on leaving Play, so
// the rest of the app stays an ordinary page (zoomable, for one).
//
// iPhone Safari ignores user-scalable=no (since iOS 10) and touch-action
// alone doesn't stop a pinch, so the pinch itself is stopped: its gesture
// events, and any touch move made with two fingers. One-finger moves are
// left alone - a sheet still scrolls.

const VIEWPORT_GAME = "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover";

export function enterGameMode(): () => void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const pageViewport = meta?.content ?? null;
  if (meta) meta.content = VIEWPORT_GAME;
  const stop = (e: Event) => e.preventDefault();
  const twoFingers = (e: TouchEvent) => {
    if (e.touches.length > 1) e.preventDefault();
  };
  // A held finger's menu (or a right click), anywhere but where you type.
  const menu = (e: Event) => {
    const t = e.target as Element | null;
    if (!t?.closest?.("input, textarea, [contenteditable]")) e.preventDefault();
  };
  const opts: AddEventListenerOptions = { passive: false };
  for (const g of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(g, stop, opts);
  document.addEventListener("touchmove", twoFingers, opts);
  document.addEventListener("contextmenu", menu);
  return () => {
    if (meta && pageViewport !== null) meta.content = pageViewport;
    for (const g of ["gesturestart", "gesturechange", "gestureend"]) document.removeEventListener(g, stop, opts);
    document.removeEventListener("touchmove", twoFingers, opts);
    document.removeEventListener("contextmenu", menu);
  };
}

// The home-screen app's status bar is a plain strip in theme-color, so it's
// kept the colour of the page's top edge under it and the page runs on into
// it: the light page, Play's felt (start screen, online lobby) - set by App -
// or, while a table is up over it, the table's dark room.
export const STATUS_LIGHT = "#f2f2f7";
export const STATUS_FELT = "#1a5639";
export const STATUS_TABLE = "#15110c";
let statusBase = STATUS_LIGHT;
let statusHeld: string | null = null;

function paintStatusBar() {
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", statusHeld ?? statusBase);
}

export function setStatusBar(colour: string) {
  statusBase = colour;
  paintStatusBar();
}

// For as long as a full-screen part is up (call its return to let go).
export function holdStatusBar(colour: string): () => void {
  statusHeld = colour;
  paintStatusBar();
  return () => {
    statusHeld = null;
    paintStatusBar();
  };
}
