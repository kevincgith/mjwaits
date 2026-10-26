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
