'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

interface StickyScoreHeaderProps {
  title: string;
  score?: number | null;
  showAfterPx?: number;
}

export default function StickyScoreHeader({ title, score, showAfterPx = 200 }: StickyScoreHeaderProps) {
  const [isVisible, setIsVisible] = useState(false);

  // Throttled scroll handler for better performance
  const handleScroll = useCallback(() => {
    setIsVisible(window.scrollY > showAfterPx);
  }, [showAfterPx]);

  useEffect(() => {
    let ticking = false;
    const throttledScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          handleScroll();
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener('scroll', throttledScroll, { passive: true });
    return () => window.removeEventListener('scroll', throttledScroll);
  }, [handleScroll]);

  if (!isVisible) return null;

  const roundedScore = score ? Math.round(score) : null;
  let scoreColorClass: string;
  let scoreTextClass = 'text-white';
  let scoreLabel = '';

  if (roundedScore === null) {
    scoreColorClass = 'bg-gray-600';
  } else if (roundedScore >= 85) {
    scoreColorClass = 'score-must-see';
    scoreTextClass = 'text-gray-900';
    scoreLabel = 'Must-See';
  } else if (roundedScore >= 75) {
    scoreColorClass = 'score-great';
    scoreLabel = 'Great';
  } else if (roundedScore >= 65) {
    scoreColorClass = 'score-good';
    scoreLabel = 'Good';
  } else if (roundedScore >= 55) {
    scoreColorClass = 'score-tepid';
    scoreTextClass = 'text-gray-900';
    scoreLabel = 'Tepid';
  } else {
    scoreColorClass = 'score-skip';
    scoreLabel = 'Skip';
  }

  return (
    <div
      className="fixed top-16 sm:top-[4.5rem] left-0 right-0 z-30 bg-surface/98 backdrop-blur-sm border-b border-white/10 transform transition-transform duration-200"
      role="banner"
      aria-label={`${title} - Score: ${roundedScore ?? 'Not rated'}`}
    >
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/"
            className="text-gray-400 hover:text-white transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded"
            aria-label="Back to all shows"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          {roundedScore !== null && (
            <div
              className={`w-8 h-8 ${scoreColorClass} rounded-lg flex items-center justify-center flex-shrink-0`}
              role="meter"
              aria-valuenow={roundedScore}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Critic Score: ${roundedScore} - ${scoreLabel}`}
            >
              <span className={`text-sm font-bold ${scoreTextClass}`} aria-hidden="true">{roundedScore}</span>
            </div>
          )}
          <h2 className="text-sm font-semibold text-white truncate">{title}</h2>
        </div>
      </div>
    </div>
  );
}
