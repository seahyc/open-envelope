import { parseSprite, type Palette } from '../pixels';

export function PixelGrid({
  rows,
  palette,
  size,
  title,
  className,
}: {
  rows: string[];
  palette: Palette;
  size: number;
  title?: string;
  className?: string;
}) {
  const pixels = parseSprite(rows, palette);
  return (
    <svg
      className={className}
      viewBox={`0 0 ${size} ${size}`}
      width={size * 2}
      height={size * 2}
      shapeRendering="crispEdges"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
    >
      {pixels.map(([x, y, fill], index) => (
        <rect key={`${x}-${y}-${index}`} x={x} y={y} width={1} height={1} fill={fill} />
      ))}
    </svg>
  );
}
