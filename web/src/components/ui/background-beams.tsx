// Aceternity UI Background Beams, adapted from the official registry (2026-10-14).
// https://ui.aceternity.com/components/background-beams
// Eight deterministic paths, a single entrance, no perpetual animation.
import { memo, useId, useRef } from 'react';
import { motion, useInView, useReducedMotion } from 'motion/react';
import { cn } from '../../lib/utils.js';

const paths = Array.from({ length: 8 }, (_, index) => {
  const offset = index * 28;
  return `M${-380 + offset} ${-189 - offset}C${-380 + offset} ${-189 - offset} ${-312 + offset} ${216 - offset} ${152 + offset} ${343 - offset}C${616 + offset} ${470 - offset} ${684 + offset} ${875 - offset} ${684 + offset} ${875 - offset}`;
});
const finalGradient = { x1: '0%', x2: '95%', y1: '0%', y2: '100%' };

const BackgroundBeams = memo(function BackgroundBeams({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true });
  const reducedMotion = useReducedMotion();

  return (
    <div ref={ref} className={cn('pointer-events-none absolute inset-0', className)} aria-hidden="true">
      <svg className="absolute h-full w-full" viewBox="0 0 696 316" fill="none" preserveAspectRatio="xMidYMid slice">
        <path d={paths.join(' ')} stroke="currentColor" strokeOpacity="0.08" strokeWidth="0.7" />
        {paths.map((path, index) => <path key={path} d={path} stroke={`url(#${id}-${index})`} strokeOpacity="0.5" strokeWidth="0.9" />)}
        <defs>
          {paths.map((_, index) => (
            <motion.linearGradient
              id={`${id}-${index}`} key={index}
              initial={false}
              animate={inView && !reducedMotion ? { x1: ['0%', '0%'], x2: ['0%', '95%'], y1: ['0%', '0%'], y2: ['0%', '100%'] } : finalGradient}
              transition={{ duration: 2.4, delay: index * 0.08, ease: 'easeOut' }}
            >
              <stop stopColor="var(--beam-start)" stopOpacity="0" />
              <stop offset="20%" stopColor="var(--beam-start)" />
              <stop offset="50%" stopColor="var(--beam-end)" />
              <stop offset="100%" stopColor="var(--beam-end)" stopOpacity="0" />
            </motion.linearGradient>
          ))}
        </defs>
      </svg>
    </div>
  );
});

export default BackgroundBeams;
