'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Horizontal poster row with prev/next arrows for mouse users.
 *
 * The rows hide their scrollbar (`scrollbar-hide`), so on desktop nothing
 * signals that they scroll. The arrows show from `sm` up (touch phones swipe)
 * and each one appears only while there is more to scroll in that direction.
 */
export default function ScrollRow({
  children,
  className = 'flex gap-3 overflow-x-auto pb-3 -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-hide',
  ...trackProps
}: {
  children: React.ReactNode;
  /** Classes for the scrolling track itself. */
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'children'>) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    update();
    el.addEventListener('scroll', update, { passive: true });
    // Observe the track (viewport changes) and each child (a filtered or
    // lazily sized row changes scrollWidth without resizing the track).
    const ro = new ResizeObserver(update);
    ro.observe(el);
    Array.from(el.children).forEach((c) => ro.observe(c));
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [update, children]);

  const scrollByPage = (dir: 1 | -1) => {
    const el = trackRef.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: reduce ? 'auto' : 'smooth' });
  };

  const arrowBase =
    'hidden sm:flex absolute top-24 -translate-y-1/2 z-10 h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-surface-elevated/95 text-white shadow-lg transition-colors hover:bg-surface-overlay focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand';

  return (
    <div className="relative">
      <div ref={trackRef} className={className} {...trackProps}>
        {children}
      </div>
      {/* Always mounted (hidden via invisible+disabled) so focus is not dropped at either end. */}
      <button type="button" aria-label="Scroll left" disabled={!canLeft} tabIndex={canLeft ? 0 : -1} onClick={() => scrollByPage(-1)} className={`${arrowBase} left-1 ${canLeft ? '' : 'invisible'}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <button type="button" aria-label="Scroll right" disabled={!canRight} tabIndex={canRight ? 0 : -1} onClick={() => scrollByPage(1)} className={`${arrowBase} right-1 ${canRight ? '' : 'invisible'}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
      </button>
    </div>
  );
}
