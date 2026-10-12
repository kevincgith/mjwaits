// How the 選牌 picker lays out its tiles, switchable from the picker's header:
//   "classic" - every suit at once, one row of 9 per suit
//   "numpad"  - one suit at a time (花 字 萬 筒 索 tabs) in a 3x3 keypad
// One shared choice for every tab's picker, per browser (localStorage); the
// default is "classic".

import { useSyncExternalStore } from "react";

export type PickerLayout = "classic" | "numpad";

const PICKER_LAYOUT_KEY = "mjwaits.pickerLayout";

function loadPickerLayout(): PickerLayout {
  try {
    if (window.localStorage.getItem(PICKER_LAYOUT_KEY) === "numpad") return "numpad";
  } catch {
    // Storage blocked - use the default.
  }
  return "classic";
}

let current: PickerLayout = loadPickerLayout();
const listeners = new Set<() => void>();

function setPickerLayout(layout: PickerLayout): void {
  current = layout;
  try {
    if (layout === "classic") window.localStorage.removeItem(PICKER_LAYOUT_KEY);
    else window.localStorage.setItem(PICKER_LAYOUT_KEY, layout);
  } catch {
    // Storage unavailable - the choice just won't survive a reload.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePickerLayout(): [PickerLayout, (layout: PickerLayout) => void] {
  return [useSyncExternalStore(subscribe, () => current), setPickerLayout];
}
