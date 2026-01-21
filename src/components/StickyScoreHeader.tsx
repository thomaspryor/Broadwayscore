'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface StickyScoreHeaderProps {
  title: string;
  score?: number | null;
  showAfterPx?: number;
}

export default function StickyScoreHeader({ title, score, showAfterPx = 200 }: StickyScoreHeaderProps) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsVisible(window.scrollY > showAfterPx);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [showAfterPx]);

  if (!isVisible) return null;

  const roundedScore = score ? Math.round(score) : null;
  const scoreColorClass = roundedScore
    ? roundedScore >= 70
      ? 'bg-score-high'
      : roundedScore >= 50
      ? 'bg-score-medium'
      : 'bg-score-low'
    : 'bg-gray-600';
  const scoreTextClass = roundedScore && roundedScore >= 50 && roundedScore < 70 ? 'text-gray-900' : 'text-white';

  return (
    <div className="fixed top-16 sm:top-18 left-0 right-0 z-40 bg-surface-dark/95 backdrop-blur-lg border-b border-white/10 transform transition-transform duration-200">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/" className="text-gray-400 hover:text-white transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          {roundedScore !== null && (
            <div className={`w-8 h-8 ${scoreColorClass} rounded-lg flex items-center justify-center flex-shrink-0`}>
              <span className={`text-sm font-bold ${scoreTextClass}`}>{roundedScore}</span>
            </div>
          )}
          <h2 className="text-sm font-semibold text-white truncate">{title}</h2>
        </div>
      </div>
    </div>
  );
}
