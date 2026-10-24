// The Play table's dice.

// The pips on each face, as cells of a 3x3 grid (1-9, reading order) - as
// on the Dice tab.
const DIE_PIPS: Record<number, number[]> = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };

// One Chinese die (red pips on the 1 and the 4), tumbling in when `rolling`.
export function PlayDie({ value, rolling, index, delay = 0 }: { value: number; rolling: boolean; index: number; delay?: number }) {
  return (
    <span
      className={`play-die${value === 1 || value === 4 ? " is-red" : ""}${value === 1 ? " is-one" : ""}${rolling ? " is-rolling" : ""}`}
      style={{ animationDelay: `${index * 70 + delay}ms` }}
      role="img"
      aria-label={`${value}`}
    >
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className={DIE_PIPS[value]?.includes(i + 1) ? "play-die-pip" : undefined} />
      ))}
    </span>
  );
}

