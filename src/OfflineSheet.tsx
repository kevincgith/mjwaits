// Behind the MJWaits icon: how much of the app is stored on this phone for
// use with no signal - the app itself (every tab, Play), the scanner, the
// bots' voices - and a button to fetch what isn't (see lib/offline.ts).
import { useEffect, useRef, useState } from "react";
import { canStore, complete, downloadPart, megabytes, offlineStatus, type OfflinePart, type OfflineStatus, type PartStatus } from "./lib/offline";

const PARTS: { part: OfflinePart; title: string; what: string }[] = [
  { part: "core", title: "App & Play", what: "Scoring, Ledger, Play and its table, Waits, Drills, Dice" },
  { part: "scanner", title: "Scanner", what: "Reading a hand from the camera or a photo" },
  { part: "voices", title: "Voices", what: "The bots' spoken lines (kept as they're heard, otherwise)" },
];

export function OfflineSheet({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<OfflineStatus | null>(null);
  const [failed, setFailed] = useState(false);
  // What's being fetched now, and how far along.
  const [busy, setBusy] = useState<{ part: OfflinePart; done: number; of: number } | null>(null);
  const [problem, setProblem] = useState<OfflinePart | null>(null);
  const stop = useRef<AbortController | null>(null);
  const live = useRef(true);

  const read = () =>
    offlineStatus().then(
      (s) => live.current && (setStatus(s), setFailed(false)),
      () => live.current && setFailed(true),
    );
  useEffect(() => {
    live.current = true;
    void read();
    // (The app fetches its own files quietly after launch: watched while this is open.)
    const again = window.setInterval(() => void read(), 3000);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      live.current = false;
      window.clearInterval(again);
      window.removeEventListener("keydown", onKey);
      stop.current?.abort();
    };
  }, [onClose]);

  const fetchPart = async (part: OfflinePart) => {
    stop.current?.abort();
    const control = (stop.current = new AbortController());
    setProblem(null);
    setBusy({ part, done: 0, of: 0 });
    try {
      await downloadPart(part, (done, of) => live.current && setBusy({ part, done, of }), control.signal);
    } catch {
      if (live.current && !control.signal.aborted) setProblem(part);
    }
    if (live.current && stop.current === control) setBusy(null);
    void read();
  };

  const storable = canStore();
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
          {status &&
            PARTS.map(({ part, title, what }) => {
              const s = status[part];
              const going = busy?.part === part;
              const done = complete(s);
              return (
                <section className="offline-row" key={part}>
                  <div className="offline-row-text">
                    <h3>
                      {title} <span className={`offline-state${done ? " is-ready" : ""}`}>{going ? (busy.of ? `Downloading ${busy.done}/${busy.of}` : "Downloading…") : line(s)}</span>
                    </h3>
                    <p>
                      {what} · {megabytes(s.bytes)}
                    </p>
                    <div className="offline-bar" role="progressbar" aria-label={`${title} stored`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((100 * s.haveBytes) / Math.max(1, s.bytes))}>
                      <span style={{ width: `${(100 * s.haveBytes) / Math.max(1, s.bytes)}%` }} />
                    </div>
                    {problem === part && <p className="offline-problem">Stopped - no connection, or no room left on this phone. What came through is kept.</p>}
                  </div>
                  {!done && storable && (
                    <button type="button" className="offline-get" disabled={!!busy} onClick={() => void fetchPart(part)}>
                      {going ? "…" : "Download"}
                    </button>
                  )}
                </section>
              );
            })}
          <p className="offline-note">The app and the scanner are fetched quietly after it opens; this shows how far that's got. Voices are big, so they're only fetched when asked for.</p>
        </div>
      </div>
    </div>
  );
}
