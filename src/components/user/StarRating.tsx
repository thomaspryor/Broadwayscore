'use client';

import { useState, useCallback, useId } from 'react';

interface StarRatingProps {
  rating: number | null;
  onRatingChange: (rating: number) => void;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  readOnly?: boolean;
  hideLabel?: boolean;
}

const SIZE_MAP = {
  xs: { star: 14, gap: 1 },
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
      <svg viewBox="0 0 24 24" fill="none" className="w-full h-full">
        <path d={STAR_PATH} fill="#FFD700" />
      </svg>
    );
  }
  if (fill === '0%') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className="w-full h-full">
        <path d={STAR_PATH} fill="none" stroke="#6B7280" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" className="absolute inset-0 w-full h-full">
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
export default function StarRating({ rating, onRatingChange, size = 'md', readOnly = false, hideLabel = false }: StarRatingProps) {
  const [hoverRating, setHoverRating] = useState<number | null>(null);
  const { star: starSize, gap } = SIZE_MAP[size];
  const uid = useId();

  const displayRating = hoverRating ?? rating ?? 0;

  const valueFromPointer = (e: React.MouseEvent, starIndex: number): number => {
    // Keyboard activation (Enter/Space) fires a click with detail 0 and no real
    // coordinates — treat it as the whole star, not a position-derived half.
    if (e.detail === 0) return starIndex;
    const rect = e.currentTarget.getBoundingClientRect();
    const isLeftHalf = e.clientX - rect.left < rect.width / 2;
    return isLeftHalf ? starIndex - 0.5 : starIndex;
  };

  const handleMouseMove = useCallback((e: React.MouseEvent, starIndex: number) => {
    if (readOnly) return;
    setHoverRating(valueFromPointer(e, starIndex));
  }, [readOnly]);

  const handleMouseLeave = useCallback(() => {
    if (readOnly) return;
    setHoverRating(null);
  }, [readOnly]);

  const handleClick = useCallback((e: React.MouseEvent, starIndex: number) => {
    if (readOnly) return;
    setHoverRating(null);
    onRatingChange(valueFromPointer(e, starIndex));
  }, [readOnly, onRatingChange]);

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
    <div className="inline-flex flex-col items-start">
      <div
        className={`inline-flex items-center ${readOnly ? '' : 'cursor-pointer'}`}
        style={{ gap }}
        onMouseLeave={handleMouseLeave}
        role={readOnly ? 'img' : 'radiogroup'}
        aria-label={readOnly ? `${(rating ?? 0).toFixed(1)} out of 5 stars` : 'Star rating'}
      >
        {[1, 2, 3, 4, 5].map(starIndex => (
          <button
            key={starIndex}
            type="button"
            disabled={readOnly}
            className={`relative rounded transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/80 ${readOnly ? 'cursor-default' : 'cursor-pointer hover:scale-110 active:scale-95'}`}
            style={{ width: starSize, height: starSize }}
            onMouseMove={readOnly ? undefined : e => handleMouseMove(e, starIndex)}
            onClick={readOnly ? undefined : e => handleClick(e, starIndex)}
            onKeyDown={readOnly ? undefined : handleArrowKey}
            aria-label={`${starIndex} star${starIndex !== 1 ? 's' : ''}`}
          >
            <StarShape fill={fillFor(displayRating, starIndex)} clipId={`half-${uid}-${starIndex}`} />
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
