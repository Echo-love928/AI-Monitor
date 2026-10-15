// Aceternity UI Grid & Dot Backgrounds — GridSmallBackgroundDemo.
// Source verified through Context7 on 2026-10-15:
// https://ui.aceternity.com/components/grid-and-dot-backgrounds
// Extract the decorative layer, use semantic colors and keep the content interactive.
import { cn } from '../../lib/utils.js';

export function GridBackground({ className }: { className?: string }) {
  return <div
    aria-hidden="true"
    className={cn(
      'pointer-events-none absolute inset-0 [background-size:20px_20px]',
      '[background-image:linear-gradient(to_right,var(--grid-color)_1px,transparent_1px),linear-gradient(to_bottom,var(--grid-color)_1px,transparent_1px)]',
      '[mask-image:radial-gradient(ellipse_at_center,black,transparent_80%)]',
      className,
    )}
  />;
}
