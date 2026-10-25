import { motion, useReducedMotion } from 'motion/react';
import type { Rect } from './useAnchorRect';

const PAD = 12;

type SpotlightProps = {
  rect: Rect | null;
  /** 0.6 in step mode; lighter while scrolling so the page stays readable. */
  dim: number;
};

/**
 * Dims the page except the anchor (12px padding, guide ring and glow). It never
 * takes pointer events, so nothing underneath is blocked.
 */
export function Spotlight({ rect, dim }: SpotlightProps) {
  const reduce = useReducedMotion();

  if (!rect) {
    return (
      <div aria-hidden className="pointer-events-none fixed inset-0 z-[70]" style={{ backgroundColor: `rgba(0,0,0,${dim})` }} />
    );
  }

  return (
    <motion.div
      aria-hidden
      className="pointer-events-none fixed z-[70] rounded-card"
      initial={false}
      animate={{
        top: rect.top - PAD,
        left: rect.left - PAD,
        width: rect.width + PAD * 2,
        height: rect.height + PAD * 2,
      }}
      transition={reduce ? { duration: 0 } : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      style={{
        boxShadow: [
          '0 0 0 2px var(--guide)',
          '0 0 28px 6px color-mix(in srgb, var(--guide) 35%, transparent)',
          `0 0 0 200vmax rgba(0,0,0,${dim})`,
        ].join(', '),
      }}
    />
  );
}
