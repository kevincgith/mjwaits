// 我的紀錄: your record at the Play table across games (see lib/playRecord).

import { useState } from "react";
import { emptyRecord, saveRecord, type PlayRecord } from "./lib/playRecord";

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");

export function RecordSheet({ record, onReset, onClose }: { record: PlayRecord; onReset: (r: PlayRecord) => void; onClose: () => void }) {
  const [armed, setArmed] = useState(false);
  const vs = Object.entries(record.vs).sort((a, b) => b[1].hands - a[1].hands);
  const firsts = Object.values(record.firsts).sort((a, b) => b.tai - a.tai || a.at - b.at);
  return (
    <div className="play-sheet-backdrop" onClick={onClose}>
      <div className="play-sheet play-record" role="dialog" aria-label="Your record" onClick={(e) => e.stopPropagation()}>
        <div className="play-sheet-head">
          <h2>我的紀錄 Your record</h2>
          <span>{record.hands ? `${record.hands} hands played` : "Play a hand to start your record"}</span>
          <button type="button" className="play-sheet-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="play-record-stats">
          <Stat label="食糊 Wins" value={String(record.wins)} sub={pct(record.wins, record.hands)} />
          <Stat label="自摸 Self-draws" value={String(record.selfDraws)} sub={pct(record.selfDraws, record.wins) + " of wins"} />
          <Stat label="出銃 Deal-ins" value={String(record.dealIns)} sub={pct(record.dealIns, record.hands)} />
          <Stat label="平均 Avg 台" value={record.wins ? (record.taiWon / record.wins).toFixed(1) : "–"} sub="per win" />
          <Stat label="最大 Best" value={record.best ? `${record.best.tai} 台` : "–"} sub={record.best ? record.best.patterns.slice(0, 3).join(" · ") : ""} />
          <Stat label="流局 Draws" value={String(record.draws)} sub={pct(record.draws, record.hands)} />
        </div>
        {vs.length > 0 && (
          <table className="play-record-vs">
            <thead>
              <tr>
                <th>Against</th>
                <th>Hands</th>
                <th>They won</th>
                <th>You dealt in</th>
                <th>They dealt in</th>
              </tr>
            </thead>
            <tbody>
              {vs.map(([key, v]) => (
                <tr key={key}>
                  <td>{v.name}</td>
                  <td>{v.hands}</td>
                  <td>{pct(v.theirWins, v.hands)}</td>
                  <td>{v.youDealtIn}</td>
                  <td>{v.theyDealtIn}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {firsts.length > 0 && (
          <div className="play-record-firsts">
            <h3>里程碑 Milestones</h3>
            <div>
              {firsts.map((f) => (
                <span key={f.name} className="play-record-badge" title={`First won ${new Date(f.at).toLocaleDateString()}`}>
                  {f.name} <b>{f.tai}</b>
                </span>
              ))}
            </div>
          </div>
        )}
        {record.hands > 0 && (
          <button
            type="button"
            className={`play-record-reset${armed ? " is-armed" : ""}`}
            onClick={() => {
              if (!armed) return setArmed(true);
              const fresh = emptyRecord();
              saveRecord(fresh);
              onReset(fresh);
              setArmed(false);
            }}
          >
            {armed ? "Tap again to clear your record" : "Reset record"}
          </button>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="play-record-stat">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{sub}</small>
    </div>
  );
}
