import { useId } from "react";

/** An empty reading shelf, without placeholder courses or document-shaped records. */
export function EmptyShelfArtwork() {
  const id = useId().replaceAll(":", "");
  return <svg className="uf-empty-shelf" viewBox="0 0 560 340" aria-hidden="true">
    <defs>
      <linearGradient id={`${id}-shelf`} x1="0" y1="0" x2=".8" y2="1"><stop stopColor="#fffefa" /><stop offset="1" stopColor="#dcd6c8" /></linearGradient>
      <linearGradient id={`${id}-front`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#d1cabb" /><stop offset="1" stopColor="#e8e2d5" /></linearGradient>
      <linearGradient id={`${id}-clay`} x1="0" y1="0" x2="1" y2=".6"><stop stopColor="#d88468" /><stop offset=".45" stopColor="#bd593e" /><stop offset="1" stopColor="#9d3f2d" /></linearGradient>
      <linearGradient id={`${id}-shade`} x1="0" y1="0" x2="1" y2="0"><stop stopColor="#a8a193" stopOpacity=".5" /><stop offset="1" stopColor="#a8a193" stopOpacity="0" /></linearGradient>
      <filter id={`${id}-soft`} x="-.2" y="-.5" width="1.4" height="2"><feGaussianBlur stdDeviation="8" /></filter>
    </defs>
    <ellipse cx="284" cy="292" rx="204" ry="15" fill="#403b31" opacity=".11" filter={`url(#${id}-soft)`} />
    <path d="m62 231 61-39h337l44 38q5 5-2 10l-60 44H103l-41-38q-8-8 0-15Z" fill={`url(#${id}-front)`} />
    <path d="m62 225 61-39h337l44 38q4 5-3 9l-62 38H103l-42-34q-7-7 1-12Z" fill={`url(#${id}-shelf)`} />
    <path d="m66 232 40 33h330l63-37" fill="none" stroke="#fffefa" strokeWidth="2" opacity=".8" />
    <path d="m119 208 107 7-20 23-100-9Z" fill={`url(#${id}-shade)`} />
    <path d="m395 207 99 18-38 25-82-20Z" fill={`url(#${id}-shade)`} />
    <g className="uf-empty-shelf__end uf-empty-shelf__end--back">
      <path d="m390 86 20-9q13-4 19 6l19 109 22 15q8 6 1 11l-38 16-51-31Z" fill="#873c2c" />
      <path d="M378 94q-1-12 11-15l12-2q11-1 13 11l20 111 23 14-30 13-49-28Z" fill={`url(#${id}-clay)`} />
      <path d="M389 84q10-3 12 7l20 111 24 14" fill="none" stroke="#efac8d" strokeWidth="2" opacity=".7" />
    </g>
    <g className="uf-empty-shelf__end uf-empty-shelf__end--front">
      <path d="m119 101 20-9q12-5 14 8l1 107 34 17q8 4 1 10l-28 18-52-29Z" fill="#863a2b" />
      <path d="m108 106 17-8q12-4 13 7l1 109 36 18-28 15-48-24Z" fill={`url(#${id}-clay)`} />
      <path d="m113 108 12-4q7-2 7 7v108l32 16" fill="none" stroke="#f1b296" strokeWidth="2" opacity=".7" />
      <path d="m99 221 48 26 28-15" fill="none" stroke="#7b3628" strokeWidth="1" opacity=".5" />
    </g>
  </svg>;
}
