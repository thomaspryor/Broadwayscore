'use client';

import { useState, useRef, useCallback } from 'react';

interface StarRatingProps {
  rating: number | null;
  onRatingChange: (rating: number) => void;
  size?: 'sm' | 'md' | 'lg';
  readOnly?: boolean;
}

const SIZE_MAP = {
  sm: { star: 20, gap: 2 },
  md: { star: 28, gap: 3 },
  lg: { star: 36, gap: 4 },
};

export default function StarRating({ rating, onRatingChange, size = 'md', readOnly = false }: StarRatingProps) {
  const [hoverRating, setHoverRating] = useState<number | null>(null);
  const [showHalfButton, setShowHalfButton] = useState(false);
  const [lastTappedStar, setLastTappedStar] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isTouchDevice = useRef(false);
  const { star: starSize, gap } = SIZE_MAP[size];

  const displayRating = hoverRating ?? rating ?? 0;

  const handleMouseMove = useCallback((e: React.MouseEvent, starIndex: number) => {
    if (readOnly) return;
    isTouchDevice.current = false;
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const isLeftHalf = x < rect.width / 2;
    setHoverRating(isLeftHalf ? starIndex - 0.5 : starIndex);
  }, [readOnly]);

  const handleMouseLeave = useCallback(() => {
    if (readOnly) return;
    setHoverRating(null);
  }, [readOnly]);

  const handleClick = useCallback((e: React.MouseEvent, starIndex: number) => {
    if (readOnly) return;

    // Desktop: use hover position for half-star precision
    if (!isTouchDevice.current) {
      const rect = (e.target as HTMLElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const isLeftHalf = x < rect.width / 2;
      const newRating = isLeftHalf ? starIndex - 0.5 : starIndex;
      onRatingChange(newRating);
      return;
    }

    // Mobile: tap = full star, show half button
    onRatingChange(starIndex);
    setLastTappedStar(starIndex);
    setShowHalfButton(true);
  }, [readOnly, onRatingChange]);

  const handleTouch = useCallback(() => {
    isTouchDevice.current = true;
  }, []);

  const handleHalfStarClick = useCallback(() => {
    if (lastTappedStar !== null) {
      onRatingChange(lastTappedStar - 0.5);
      setShowHalfButton(false);
    }
  }, [lastTappedStar, onRatingChange]);

  const getFillWidth = (starIndex: number): string => {
    if (displayRating >= starIndex) return '100%';
    if (displayRating >= starIndex - 0.5) return '50%';
    return '0%';
  };

  return (
    <div className="inline-flex flex-col items-start">
      <div
        ref={containerRef}
        className={`inline-flex items-center ${readOnly ? '' : 'cursor-pointer'}`}
        style={{ gap }}
        onMouseLeave={handleMouseLeave}
        onTouchStart={handleTouch}
        role="radiogroup"
        aria-label="Star rating"
      >
        {[1, 2, 3, 4, 5].map(starIndex => (
          <button
            key={starIndex}
            type="button"
            disabled={readOnly}
            className={`relative ${readOnly ? 'cursor-default' : 'cursor-pointer'} transition-transform ${
              !readOnly ? 'hover:scale-110 active:scale-95' : ''
            }`}
            style={{ width: starSize, height: starSize }}
            onMouseMove={e => handleMouseMove(e, starIndex)}
            onClick={e => handleClick(e, starIndex)}
            aria-label={`${starIndex} star${starIndex !== 1 ? 's' : ''}`}
          >
            {/* Empty star (background) */}
            <svg
              viewBox="0 0 24 24"
              fill="none"
              className="absolute inset-0 w-full h-full text-gray-600"
            >
              <path
                d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                fill="currentColor"
              />
            </svg>
            {/* Filled star (clipped) */}
            <div
              className="absolute inset-0 overflow-hidden transition-all duration-75"
              style={{ width: getFillWidth(starIndex) }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                className="w-full h-full"
                style={{ width: starSize, height: starSize }}
              >
                <path
                  d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                  fill="#FFD700"
                />
              </svg>
            </div>
          </button>
        ))}

        {/* Rating label */}
        {rating !== null && (
          <span className={`ml-1 font-bold text-white ${
            size === 'sm' ? 'text-xs' : size === 'md' ? 'text-sm' : 'text-base'
          }`}>
            {rating.toFixed(1)}
          </span>
        )}
      </div>

      {/* Mobile half-star button */}
      {showHalfButton && !readOnly && lastTappedStar !== null && (
        <button
          type="button"
          onClick={handleHalfStarClick}
          className="mt-1.5 px-2.5 py-1 text-xs font-semibold text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-full hover:bg-amber-500/20 transition-colors"
        >
          Make it {(lastTappedStar - 0.5).toFixed(1)} ½
        </button>
      )}
    </div>
  );
}
