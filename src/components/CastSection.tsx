'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { CastMemberOBC } from '@/lib/data-types';
import type { ShowTonyInfo } from '@/lib/data-tony-noms';
import { TrophyIcon } from '@/components/icons';
import { isLondonMarket } from '@/lib/market-utils';

function abbreviateTonyCategory(categories: string[]): string {
  // Prefer acting categories in cast context (more relevant than "Book" or "Score")
  const actingCats = categories.filter(c =>
    c.includes('Actor') || c.includes('Actress')
  );
  const cat = (actingCats.length > 0 ? actingCats[0] : categories[0]) || '';
  let s = cat.replace('Best ', '');
  if (s.includes(' in a Musical')) return s.replace(' in a Musical', '') + ' (Musical)';
  if (s.includes(' in a Play')) return s.replace(' in a Play', '') + ' (Play)';
  if (s.includes(' of a Musical')) return s.replace(' of a Musical', '') + ' (Musical)';
  if (s.includes(' of a Play')) return s.replace(' of a Play', '') + ' (Play)';
  return s;
}

interface CastSectionProps {
  openingNightCast: CastMemberOBC[];
  currentCast?: CastMemberOBC[] | null;
  currentCastUpdatedAt?: string | null;
  replacements?: CastMemberOBC[] | null;
  showStatus: string;
  category?: string;
  actorSlugs?: Record<string, string>;  // ibdbPersonId → slug
  tonyMap?: Record<string, ShowTonyInfo>;  // ibdbPersonId → Tony info for this show
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

function CastList({ cast, initialCount = INITIAL_COUNT, actorSlugs, tonyMap }: { cast: CastMemberOBC[]; initialCount?: number; actorSlugs?: Record<string, string>; tonyMap?: Record<string, ShowTonyInfo> }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? cast : cast.slice(0, initialCount);
  const hasMore = cast.length > initialCount;

  return (
    <>
      <ul className="space-y-2 sm:space-y-1.5">
        {visible.map((member, i) => {
          const slug = member.ibdbPersonId && actorSlugs?.[member.ibdbPersonId];
          const tonyInfo = member.ibdbPersonId && tonyMap?.[member.ibdbPersonId];
          return (
            <li key={i} className="flex flex-col sm:flex-row sm:items-baseline text-sm gap-0.5 sm:gap-0 flex-wrap">
              {slug ? (
                <Link href={`/cast/${slug}`} className="text-white font-medium hover:text-brand transition-colors">
                  {member.name}
                </Link>
              ) : (
                <span className="text-white font-medium">{member.name}</span>
              )}
              <span className="text-gray-500 text-xs sm:text-sm sm:before:content-['·'] sm:before:mx-2 sm:before:text-gray-600">
                {member.role}
              </span>
              {tonyInfo && (
                <span className={`self-start inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded border sm:ml-1.5 ${
                  tonyInfo.won
                    ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30'
                    : 'bg-sky-500/15 text-sky-400 border-sky-500/25'
                }`} title={tonyInfo.categories.join(', ')}>
                  <TrophyIcon className="w-2.5 h-2.5" />
                  {tonyInfo.won ? 'Winner' : 'Nom'}: {abbreviateTonyCategory(tonyInfo.categories)}
                </span>
              )}
              {member.flags && member.flags.length > 0 && (
                <span className="text-xs text-amber-500/70 sm:ml-2">
                  {member.flags.join(', ')}
                </span>
              )}
            </li>
          );
        })}
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

export default function CastSection({ openingNightCast, currentCast, currentCastUpdatedAt, replacements, showStatus, category, actorSlugs, tonyMap }: CastSectionProps) {
  const hasOBC = openingNightCast.length > 0;
  const hasCurrentCast = currentCast && currentCast.length > 0;
  const hasReplacements = replacements && replacements.length > 0;
  const isOpen = showStatus === 'open' || showStatus === 'previews' || showStatus === 'upcoming';

  if (!hasOBC && !hasCurrentCast && !hasReplacements) return null;

  // Unified eyebrow style used for every sub-heading in this content card,
  // matching the show-card chrome family (audience/critic/awards/etc.).
  const eyebrow = "text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0";

  return (
    <div className="mb-8">
      <section className="card p-5 sm:p-6">
        {/* Current Cast — shown first for open shows */}
        {isOpen && hasCurrentCast && (
          <>
            <header className="flex items-center justify-between gap-3 mb-4">
              <h2 className={eyebrow}>Current Cast</h2>
              {currentCastUpdatedAt && (
                <span className="text-[11px] font-medium tracking-[0.06em] text-gray-500 lowercase shrink-0">
                  updated {formatDate(currentCastUpdatedAt)}
                </span>
              )}
            </header>
            <CastList cast={currentCast!} actorSlugs={actorSlugs} tonyMap={tonyMap} />
            {hasOBC && <div className="border-t border-white/10 my-5" />}
          </>
        )}

        {/* Opening Night Cast */}
        {hasOBC && (
          <>
            <h2 className={`${eyebrow} mb-4`}>
              {category === 'broadway' || !category ? 'Original Broadway Cast' : isLondonMarket(category) ? 'Original London Cast' : 'Original Cast'}
            </h2>
            <CastList cast={openingNightCast} actorSlugs={actorSlugs} tonyMap={tonyMap} />
          </>
        )}

        {/* Replacements */}
        {hasReplacements && (
          <>
            {hasOBC && <div className="border-t border-white/10 my-5" />}
            <h2 className={`${eyebrow} mb-4`}>
              Notable Replacements
            </h2>
            <CastList cast={replacements!} actorSlugs={actorSlugs} tonyMap={tonyMap} />
          </>
        )}
      </section>
    </div>
  );
}
