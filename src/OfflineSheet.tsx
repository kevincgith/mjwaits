// Behind the MJWaits icon: how much of the app is stored on this phone for
// use with no signal - the app itself (every tab, Play), the scanner, the
// bots' voices - and a button to fetch what isn't (see lib/offline.ts). A
// fetch goes on with this sheet shut: it's the app's, not the sheet's.
import { useEffect, useRef, useState } from "react";
import { canStore, complete, currentDownload, megabytes, offlineStatus, startDownload, stopDownload, watchDownloads, type OfflinePart, type OfflineStatus, type PartStatus } from "./lib/offline";

const PARTS: { part: OfflinePart; title: string; what: string }[] = [
  { part: "core", title: "App & Play", what: "Scoring, Ledger, Play and its table, Waits, Drills, Dice" },
  { part: "scanner", title: "Scanner", what: "Reading a hand from the camera or a photo - and what the learned opponents run on" },
  { part: "voices", title: "Voices", what: "The bots' spoken lines (kept as they're heard, otherwise)" },
];

export function OfflineSheet({ onClose }: { onClose: () => void }) {
  // null: not known - yet, or (unknown) this build's list couldn't be had.
  const [status, setStatus] = useState<OfflineStatus | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(currentDownload);
  // (Read through a ref: the parent hands a new function every render, and
  // this sheet's one effect must run once, not on each of those.)
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    let live = true;
    const read = () =>
      offlineStatus().then(
        (s) => live && (setStatus(s), setUnknown(s === null), setFailed(false)),
        () => live && setFailed(true),
      );
    void read();
    // (The app fetches its own files quietly after launch: watched while this is open.)
    const again = window.setInterval(() => void read(), 3000);
    const unwatch = watchDownloads(() => {
      if (!live) return;
      setBusy(currentDownload());
      if (!currentDownload()) void read();
    });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", onKey);
    return () => {
      live = false;
      window.clearInterval(again);
      unwatch();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const storable = canStore();
  const going = busy && !busy.failed ? busy : null;
  const line = (s: PartStatus) => (complete(s) ? "Ready offline" : s.have === 0 ? "Not downloaded" : `${Math.floor((100 * s.haveBytes) / Math.max(1, s.bytes))}% downloaded`);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet offline-sheet" role="dialog" aria-modal="true" aria-label="Offline use" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <span className="sheet-title">Offline use</span>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="sheet-list offline-list">
          {!storable && <p className="offline-note">Nothing can be kept for offline use here (a private window, or the app hasn't finished setting up - reload once and look again).</p>}
          {failed && !status && <p className="offline-note">Couldn't check what's stored - no connection?</p>}
          {unknown && <p className="offline-note">Checking what this version needs… (it's just been updated, or there's no connection - look again in a moment).</p>}
          {status &&
            PARTS.map(({ part, title, what }) => {
              const s = status[part];
              const mine = going?.part === part;
              const done = complete(s);
              return (
                <section className="offline-row" key={part}>
                  <div className="offline-row-text">
                    <h3>
                      {title} <span className={`offline-state${done ? " is-ready" : ""}`}>{mine ? (going.of ? `Downloading ${going.done}/${going.of}` : "Downloading…") : line(s)}</span>
                    </h3>
                    <p>
                      {what} · {megabytes(s.bytes)}
                    </p>
                    <div className="offline-bar" role="progressbar" aria-label={`${title} stored`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((100 * s.haveBytes) / Math.max(1, s.bytes))}>
                      <span style={{ width: `${(100 * s.haveBytes) / Math.max(1, s.bytes)}%` }} />
                    </div>
                    {busy?.failed && busy.part === part && <p className="offline-problem">Stopped - no connection, or no room left on this phone. What came through is kept.</p>}
                  </div>
                  {mine ? (
                    <button type="button" className="offline-get" onClick={stopDownload}>
                      Stop
                    </button>
                  ) : (
                    !done &&
                    storable && (
                      <button type="button" className="offline-get" disabled={!!going} onClick={() => startDownload(part)}>
                        Download
                      </button>
                    )
                  )}
                </section>
              );
            })}
          <p className="offline-note">The app and the scanner are fetched quietly after it opens; this shows how far that's got. Voices are big, so they're only fetched when asked for - and go on downloading with this closed.</p>
        </div>
      </div>
    </div>
  );
}
