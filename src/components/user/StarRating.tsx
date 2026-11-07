'use client';

import { useState, useCallback, useId } from 'react';

interface StarRatingProps {
  rating: number | null;
  onRatingChange: (rating: number) => void;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  readOnly?: boolean;
  hideLabel?: boolean;
  /** Expand each star's hit target ~12px beyond the glyph (invisible pseudo-element).
   *  ONLY for poster-overlay strips with empty space around the stars — in dense
   *  rows (My Shows To-Be-Rated) the halo would swallow taps meant for neighbors. */
  expandHitTarget?: boolean;
  /** Live hover preview (null on leave) — lets the parent echo the would-be value. */
  onHoverChange?: (value: number | null) => void;
  /** Phones only (below sm): spread the five stars across the container width instead of
   *  clustering them left. Each button becomes a full fifth of the row (no dead gaps between
   *  stars) and the glyph is centred in it, so the half-star maths still reads the button rect.
   *  From sm up the row keeps its fixed size. (BRO-6719 mobile web, matches the iOS app.) */
  fill?: boolean;
}

const SIZE_MAP = {
  xs: { star: 16, gap: 2 },
  sm: { star: 20, gap: 2 },
  md: { star: 28, gap: 3 },
  lg: { star: 40, gap: 4 },
};

const STAR_PATH = 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z';

/**
 * Renders a single star at a given fill level. `clipId` must be unique per
 * StarRating instance so multiple star rows on one page don't share a clipPath.
 */
function StarShape({ fill, clipId }: { fill: '0%' | '50%' | '100%'; clipId: string }) {
  if (fill === '100%') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className="w-full h-full pointer-events-none">
        <path d={STAR_PATH} fill="#FFD700" />
      </svg>
    );
  }
  if (fill === '0%') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className="w-full h-full pointer-events-none">
        <path d={STAR_PATH} fill="none" stroke="#6B7280" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" className="absolute inset-0 w-full h-full pointer-events-none">
      <defs>
        <clipPath id={clipId}>
          <rect x="0" y="0" width="12" height="24" />
        </clipPath>
      </defs>
      <path d={STAR_PATH} fill="none" stroke="#6B7280" strokeWidth="1.5" strokeLinejoin="round" />
      <path d={STAR_PATH} fill="#FFD700" clipPath={`url(#${clipId})`} />
    </svg>
  );
}

function fillFor(displayRating: number, starIndex: number): '0%' | '50%' | '100%' {
  if (displayRating >= starIndex) return '100%';
  if (displayRating >= starIndex - 0.5) return '50%';
  return '0%';
}

/**
 * Half-star rating input. One button per star; the clicked/hovered half is
 * derived from the pointer x-position relative to the button. This works
 * identically on mouse and touch (a tap fires a click carrying clientX), which
 * is the whole point — the previous isTouchDevice/synthetic-mousemove heuristic
 * broke half-stars on real phones.
 */
export default function StarRating({ rating, onRatingChange, size = 'md', readOnly = false, hideLabel = false, expandHitTarget = false, onHoverChange, fill = false }: StarRatingProps) {
  const [hoverRating, setHoverRating] = useState<number | null>(null);
  const { star: starSize, gap } = SIZE_MAP[size];
  const uid = useId();

  const displayRating = hoverRating ?? rating ?? 0;

  const valueFromPointer = (e: React.MouseEvent, starIndex: number): number => {
    // Keyboard activation (Enter/Space) fires a CLICK with detail 0 and no real
    // coordinates — treat it as the whole star, not a position-derived half.
    // The e.type guard is load-bearing: detail is ALWAYS 0 on mousemove (it
    // only counts clicks), so a bare detail check made every hover snap to the
    // whole star while clicks computed halves — hover said 3.0, click saved
    // 2.5 (the "buggy desktop half-stars" report, fixed 2026-07-13).
    if (e.type === 'click' && e.detail === 0) return starIndex;
    // clientX vs getBoundingClientRect: both viewport-space, so the comparison
    // is exact. offsetX (target-local) misreported halves in production even
    // with pointer-events-none children — verified live 2026-07-13. rect math
    // is safe here only because the button has no transform (hover scale was
    // removed in the same fix cycle); don't reintroduce scale animations.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const isLeftHalf = e.clientX - rect.left < rect.width / 2;
    return isLeftHalf ? starIndex - 0.5 : starIndex;
  };

  const setHover = useCallback((value: number | null) => {
    setHoverRating(value);
    onHoverChange?.(value);
  }, [onHoverChange]);

  const handleMouseMove = useCallback((e: React.MouseEvent, starIndex: number) => {
    if (readOnly) return;
    setHover(valueFromPointer(e, starIndex));
  }, [readOnly, setHover]);

  const handleMouseLeave = useCallback(() => {
    if (readOnly) return;
    setHover(null);
  }, [readOnly, setHover]);

  const handleClick = useCallback((e: React.MouseEvent, starIndex: number) => {
    if (readOnly) return;
    setHover(null);
    onRatingChange(valueFromPointer(e, starIndex));
  }, [readOnly, setHover, onRatingChange]);

  // Arrow keys adjust in half-star steps — Enter/Space on a star can only give
  // whole values, so without this, keyboard users can't reach 3.5 etc. (audit P2).
  const handleArrowKey = useCallback((e: React.KeyboardEvent) => {
    if (readOnly) return;
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 0.5
      : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -0.5 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = Math.min(5, Math.max(0.5, (rating ?? 0) + delta));
    onRatingChange(next);
  }, [readOnly, rating, onRatingChange]);

  // Label renders only for a committed rating — mounting it on hover-enter when
  // rating is null shifted tightly-packed rows (My Shows "To Be Rated" renders
  // interactive null-rating stars without hideLabel). Hover previews via fills.
  const labelValue = rating !== null ? (readOnly ? rating : hoverRating ?? rating) : null;

  return (
    <div className={fill ? 'flex w-full flex-col items-start sm:inline-flex sm:w-auto' : 'inline-flex flex-col items-start'}>
      <div
        // star-compact: readOnly display stars must not inherit the mobile
        // 44px tap-target minimums — they're non-interactive, and the minimums
        // ballooned xs stars into row-crushing giants (2026-07-19).
        className={`${fill ? 'flex w-full gap-0 sm:inline-flex sm:w-auto sm:gap-[var(--gap)]' : 'inline-flex'} items-center ${readOnly ? 'star-compact' : 'cursor-pointer'}`}
        style={fill ? ({ '--gap': `${gap}px` } as React.CSSProperties) : { gap }}
        data-fill={fill ? 'true' : undefined}
        onMouseLeave={handleMouseLeave}
        role={readOnly ? 'img' : 'radiogroup'}
        aria-label={readOnly ? `${(rating ?? 0).toFixed(1)} out of 5 stars` : 'Star rating'}
      >
        {[1, 2, 3, 4, 5].map(starIndex => (
          <button
            key={starIndex}
            type="button"
            disabled={readOnly}
            className={`relative rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/80 ${readOnly ? 'cursor-default' : 'cursor-pointer'} ${
              // Hover-rate stars (xs) render tiny on poster overlays — the visible glyph stays
              // small on purpose, but the click/tap target expands via an invisible pseudo-element
              // into the surrounding gap/padding, which has room to spare on the poster.
              !readOnly && expandHitTarget ? "before:content-[''] before:absolute before:-inset-3" : ''
            } ${fill ? 'flex h-14 min-w-0 flex-1 items-center justify-center sm:h-[var(--star)] sm:w-[var(--star)] sm:flex-none' : ''}`}
            // Phones: the button is as tall as the largest glyph (56px = h-14), so the whole
            // glyph is inside the tap target. An inline height of 40px lost to the global 44px
            // mobile min-height and left the glyph 6px taller than its button.
            style={fill ? ({ '--star': `${starSize}px` } as React.CSSProperties) : { width: starSize, height: starSize }}
            onMouseMove={readOnly ? undefined : e => handleMouseMove(e, starIndex)}
            onClick={readOnly ? undefined : e => handleClick(e, starIndex)}
            onKeyDown={readOnly ? undefined : handleArrowKey}
            aria-label={`${starIndex} star${starIndex !== 1 ? 's' : ''}`}
          >
            {fill ? (
              <span className="relative block aspect-square w-[min(56px,100%)] sm:w-full pointer-events-none">
                <StarShape fill={fillFor(displayRating, starIndex)} clipId={`half-${uid}-${starIndex}`} />
              </span>
            ) : (
              <StarShape fill={fillFor(displayRating, starIndex)} clipId={`half-${uid}-${starIndex}`} />
            )}
          </button>
        ))}
        {labelValue !== null && labelValue !== undefined && !hideLabel && (
          <span className={`ml-1 font-bold text-white ${size === 'sm' ? 'text-xs' : size === 'md' ? 'text-sm' : 'text-base'}`}>
            {labelValue.toFixed(1)}
          </span>
        )}
      </div>
    </div>
  );
}
