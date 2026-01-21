'use client';

import { useState, useEffect, useRef } from 'react';

interface AnimatedScoreDistributionProps {
  reviews: { reviewMetaScore: number }[];
}

export default function AnimatedScoreDistribution({ reviews }: AnimatedScoreDistributionProps) {
  const [isVisible, setIsVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const high = reviews.filter(r => r.reviewMetaScore >= 70).length;
  const medium = reviews.filter(r => r.reviewMetaScore >= 50 && r.reviewMetaScore < 70).length;
  const low = reviews.filter(r => r.reviewMetaScore < 50).length;
  const total = reviews.length;

  const highPct = Math.round((high / total) * 100);
  const mediumPct = Math.round((medium / total) * 100);
  const lowPct = Math.round((low / total) * 100);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.2 }
    );

    if (ref.current) {
      observer.observe(ref.current);
    }

    return () => observer.disconnect();
  }, []);

  if (total === 0) return null;

  return (
    <div ref={ref} className="mb-5 space-y-2">
      {/* Positive */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-400 w-16">Positive</span>
        <div className="flex-1 h-2.5 bg-surface-overlay rounded-full overflow-hidden">
          <div
            className="bg-score-high h-full rounded-full transition-all duration-700 ease-out"
            style={{ width: isVisible ? `${highPct}%` : '0%' }}
          />
        </div>
        <span className="text-xs font-medium text-gray-300 w-12 text-right">{high} ({highPct}%)</span>
      </div>
      {/* Mixed */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-400 w-16">Mixed</span>
        <div className="flex-1 h-2.5 bg-surface-overlay rounded-full overflow-hidden">
          <div
            className="bg-score-medium h-full rounded-full transition-all duration-700 ease-out delay-100"
            style={{ width: isVisible ? `${mediumPct}%` : '0%' }}
          />
        </div>
        <span className="text-xs font-medium text-gray-300 w-12 text-right">{medium} ({mediumPct}%)</span>
      </div>
      {/* Negative */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-400 w-16">Negative</span>
        <div className="flex-1 h-2.5 bg-surface-overlay rounded-full overflow-hidden">
          <div
            className="bg-score-low h-full rounded-full transition-all duration-700 ease-out delay-200"
            style={{ width: isVisible ? `${lowPct}%` : '0%' }}
          />
        </div>
        <span className="text-xs font-medium text-gray-300 w-12 text-right">{low} ({lowPct}%)</span>
      </div>
    </div>
  );
}
