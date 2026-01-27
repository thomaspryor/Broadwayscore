'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';

interface ScoreTooltipProps {
  score: number;
  label: string;
  tier1Count: number;
  tier2Count: number;
  tier3Count: number;
  totalReviews: number;
  children: React.ReactNode;
  size?: 'sm' | 'md'; // sm for homepage cards, md for show pages
}

function getScoreColor(score: number): string {
  if (score >= 85) return 'text-amber-400';
  if (score >= 75) return 'text-emerald-400';
  if (score >= 65) return 'text-teal-400';
  if (score >= 55) return 'text-amber-500';
  return 'text-red-400';
}

export default function ScoreTooltip({
  score,
  label,
  tier1Count,
  tier2Count,
  tier3Count,
  totalReviews,
  children,
  size = 'md',
}: ScoreTooltipProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<'bottom' | 'top'>('top');
  const [horizontalOffset, setHorizontalOffset] = useState(0);
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Adjust position based on viewport
  useEffect(() => {
    if (isOpen && triggerRef.current && tooltipRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const tooltipRect = tooltipRef.current.getBoundingClientRect();
      const tooltipHeight = tooltipRect.height;
      const tooltipWidth = tooltipRect.width;

      // Vertical positioning - prefer top to avoid cutting off at bottom
      const spaceAbove = triggerRect.top;
      const spaceBelow = window.innerHeight - triggerRect.bottom;

      if (spaceAbove > tooltipHeight + 20) {
        setPosition('top');
      } else if (spaceBelow > tooltipHeight + 20) {
        setPosition('bottom');
      } else {
        // Not enough space either way, use whichever has more
        setPosition(spaceAbove > spaceBelow ? 'top' : 'bottom');
      }

      // Horizontal positioning - keep tooltip within viewport
      const tooltipCenter = triggerRect.left + triggerRect.width / 2;
      const tooltipLeft = tooltipCenter - tooltipWidth / 2;
      const tooltipRight = tooltipCenter + tooltipWidth / 2;

      if (tooltipLeft < 10) {
        setHorizontalOffset(10 - tooltipLeft);
      } else if (tooltipRight > window.innerWidth - 10) {
        setHorizontalOffset(window.innerWidth - 10 - tooltipRight);
      } else {
        setHorizontalOffset(0);
      }
    }
  }, [isOpen]);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        tooltipRef.current &&
        !tooltipRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const scoreColor = getScoreColor(score);
  const isSmall = size === 'sm';

  return (
    <div className="relative inline-block">
      <div
        ref={triggerRef}
        onMouseEnter={() => setIsOpen(true)}
        onMouseLeave={() => setIsOpen(false)}
        onClick={() => setIsOpen(!isOpen)}
        className="cursor-help"
      >
        {children}
      </div>

      {isOpen && (
        <div
          ref={tooltipRef}
          className={`absolute z-[100] ${isSmall ? 'w-52 p-3' : 'w-64 p-4'} bg-surface-elevated border border-white/10 rounded-xl shadow-2xl transition-opacity duration-150 ${
            position === 'bottom' ? 'top-full mt-2' : 'bottom-full mb-2'
          } left-1/2`}
          style={{ transform: `translateX(calc(-50% + ${horizontalOffset}px))` }}
          onMouseEnter={() => setIsOpen(true)}
          onMouseLeave={() => setIsOpen(false)}
        >
          {/* Arrow */}
          <div
            className={`absolute left-1/2 w-3 h-3 bg-surface-elevated border-white/10 rotate-45 ${
              position === 'bottom'
                ? '-top-1.5 border-l border-t'
                : '-bottom-1.5 border-r border-b'
            }`}
            style={{ transform: `translateX(calc(-50% - ${horizontalOffset}px))` }}
          />

          {/* Header */}
          <div className={`flex items-center gap-2 ${isSmall ? 'mb-2 pb-1.5' : 'mb-3 pb-2'} border-b border-white/10`}>
            <span className={`${isSmall ? 'text-xl' : 'text-2xl'} font-bold ${scoreColor}`}>{Math.round(score)}</span>
            <span className="text-gray-400 text-sm">/100</span>
            <span className={`text-gray-300 ml-1 ${isSmall ? 'text-xs' : 'text-sm'}`}>{label}</span>
          </div>

          {/* Tier Breakdown */}
          <div className={isSmall ? 'mb-2' : 'mb-3'}>
            <p className="text-xs text-gray-400 mb-1.5">
              Based on {totalReviews} review{totalReviews !== 1 ? 's' : ''}:
            </p>
            <ul className={`${isSmall ? 'text-xs' : 'text-sm'} space-y-0.5`}>
              {tier1Count > 0 && (
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                  <span className="text-gray-300">{tier1Count} Tier 1</span>
                  <span className="text-gray-500 text-[10px]">(full weight)</span>
                </li>
              )}
              {tier2Count > 0 && (
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                  <span className="text-gray-300">{tier2Count} Tier 2</span>
                  <span className="text-gray-500 text-[10px]">(0.7x)</span>
                </li>
              )}
              {tier3Count > 0 && (
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                  <span className="text-gray-300">{tier3Count} Tier 3</span>
                  <span className="text-gray-500 text-[10px]">(0.4x)</span>
                </li>
              )}
            </ul>
          </div>

          {/* Score Tiers - compact */}
          <div className={`${isSmall ? 'mb-2 pb-1.5' : 'mb-3 pb-2'} border-t border-white/10 pt-2`}>
            <div className="text-[10px] flex flex-wrap gap-x-2 gap-y-0.5">
              <span className="text-amber-400">85+ Must-See</span>
              <span className="text-emerald-400">75+ Recommended</span>
              <span className="text-teal-400">65+ Worth Seeing</span>
              <span className="text-red-400">&lt;65 Skip</span>
            </div>
          </div>

          {/* Link to Methodology */}
          <Link
            href="/methodology"
            className={`text-brand hover:text-brand-hover ${isSmall ? 'text-xs' : 'text-sm'} flex items-center gap-1 transition-colors`}
            onClick={(e) => e.stopPropagation()}
          >
            How we score
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>
      )}
    </div>
  );
}
