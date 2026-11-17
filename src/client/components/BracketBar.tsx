export type BarTone = 'fill' | 'rainbow' | 'over';

export function barFillCount(ratio: number, cells: number): number {
  return Math.max(0, Math.min(cells, Math.round(ratio * cells)));
}

export function BracketBar({
  ratio,
  cells = 12,
  tone = 'fill',
  label,
}: {
  ratio: number;
  cells?: number;
  tone?: BarTone;
  label?: string;
}) {
  const filled = barFillCount(ratio, cells);
  const over = tone === 'over';
  const value = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  return (
    <span
      className={`bracket-bar is-${tone}`}
      role="progressbar"
      aria-valuenow={over ? 100 : value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className="br" aria-hidden="true">[</span>
      <span className="cells" aria-hidden="true">
        {Array.from({ length: cells }, (_, index) => (
          <span key={index} className={index < filled || over ? 'fill' : 'empty'}>
            {index < filled || over ? '█' : '░'}
          </span>
        ))}
      </span>
      <span className="br" aria-hidden="true">]</span>
      {over ? <span className="bang">!</span> : null}
      {over ? <span className="bar-label"> OVER</span> : null}
      {label ? <span className="bar-label"> {label}</span> : null}
    </span>
  );
}
