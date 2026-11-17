import { PixelIcon } from './PixelIcon';

const RAINBOW = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de'];

export function RainbowDigits({ text }: { text: string }) {
  return (
    <span className="rainbow-digits" data-testid="review-clear">
      {[...text].map((ch, index) => (
        <span key={`${ch}-${index}`} style={{ color: RAINBOW[index % RAINBOW.length] }}>
          {ch === ' ' ? '\u00a0' : ch}
        </span>
      ))}
    </span>
  );
}

export function PixelStar({ label = 'star' }: { label?: string }) {
  return (
    <span className="pixel-star">
      <PixelIcon name="star" active title={label} />
    </span>
  );
}

export function RewardBurst() {
  return (
    <div className="reward-burst" data-testid="review-reward" aria-hidden="true">
      <PixelStar />
      <PixelStar />
      <PixelStar />
    </div>
  );
}
