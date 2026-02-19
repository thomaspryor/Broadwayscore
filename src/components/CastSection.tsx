'use client';

import { useState } from 'react';
import type { CastMemberOBC } from '@/lib/data-types';

interface CastSectionProps {
  openingNightCast: CastMemberOBC[];
  currentCast?: CastMemberOBC[] | null;
  currentCastUpdatedAt?: string | null;
  showStatus: string;
}

const INITIAL_COUNT = 8;

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

function CastList({ cast, initialCount = INITIAL_COUNT }: { cast: CastMemberOBC[]; initialCount?: number }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? cast : cast.slice(0, initialCount);
  const hasMore = cast.length > initialCount;

  return (
    <>
      <ul className="space-y-2 sm:space-y-1.5">
        {visible.map((member, i) => (
          <li key={i} className="flex flex-col sm:flex-row sm:items-baseline text-sm gap-0.5 sm:gap-0">
            <span className="text-white font-medium">{member.name}</span>
            <span className="text-gray-500 text-xs sm:text-sm sm:before:content-['·'] sm:before:mx-2 sm:before:text-gray-600">
              {member.role}
            </span>
            {member.flags && member.flags.length > 0 && (
              <span className="text-xs text-amber-500/70 sm:ml-2">
                {member.flags.join(', ')}
              </span>
            )}
          </li>
        ))}
      </ul>
      {hasMore && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-3 text-xs text-gray-400 hover:text-white transition-colors"
        >
          {expanded ? 'Show less' : `Show all ${cast.length} cast members`}
        </button>
      )}
    </>
  );
}

export default function CastSection({ openingNightCast, currentCast, currentCastUpdatedAt, showStatus }: CastSectionProps) {
  const hasOBC = openingNightCast.length > 0;
  const hasCurrentCast = currentCast && currentCast.length > 0;
  const isOpen = showStatus === 'open' || showStatus === 'previews';

  if (!hasOBC && !hasCurrentCast) return null;

  return (
    <div className="mb-8">
      <div className="card p-5 sm:p-6">
        {/* Current Cast — shown first for open shows */}
        {isOpen && hasCurrentCast && (
          <>
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Current Cast</h2>
              {currentCastUpdatedAt && (
                <span className="text-xs text-gray-500">Updated {formatDate(currentCastUpdatedAt)}</span>
              )}
            </div>
            <CastList cast={currentCast!} />
            {hasOBC && <div className="border-t border-white/10 my-5" />}
          </>
        )}

        {/* Opening Night Cast */}
        {hasOBC && (
          <>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
              Original Broadway Cast
            </h2>
            <CastList cast={openingNightCast} />
          </>
        )}
      </div>
    </div>
  );
}
