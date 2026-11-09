import { getAllShows } from '@/lib/data-core';
import ShowImage from '@/components/ShowImage';
import { DatedBookmarkButton } from '@/components/user/ShowPageBookmark';

/**
 * Visual fixture for the poster ribbon (BRO-6942): every state side by side on
 * real posters, with a fixed "today" so screenshots are stable. Guarded by /test.
 */
export const dynamic = 'force-dynamic';
const TODAY = '2026-11-04';

export default function BookmarkRibbonFixture() {
  const shows = getAllShows().filter(s => s.images?.poster).slice(0, 5);
  const states: Array<{ label: string; date?: string; rated?: boolean; plain?: boolean }> = [
    { label: 'Upcoming', date: '2026-11-17' },
    { label: 'Seen (past)', date: '2026-10-26' },
    { label: 'Rated', rated: true },
    { label: 'No date', plain: true },
    { label: 'Dec 31', date: '2026-12-31' },
  ];
  return (
    <main className="bg-surface min-h-screen p-4">
      <div className="flex flex-wrap gap-4">
        {states.map((st, i) => {
          const show = shows[i];
          if (!show) return null;
          return (
            <div key={st.label} className="w-28 sm:w-32">
              <div className="relative rounded-lg overflow-hidden bg-surface-overlay aspect-[2/3]">
                <ShowImage sources={[show.images?.poster ?? null, show.images?.thumbnail ?? null]} alt={show.title} sizes="128px" className="w-full h-full object-cover" fallback={<div />} />
                {st.date && <DatedBookmarkButton plannedDate={st.date} today={TODAY} />}
                {st.rated && (
                  <div className="absolute top-1 right-1 z-10 flex items-center gap-0.5 rounded-full bg-surface/90 border border-amber-400/30 px-1.5 py-0.5 text-xs font-bold text-[#FFD700]" role="img" aria-label="Your rating: 4.5 stars">
                    <span aria-hidden="true">★</span><span className="tabular-nums">4.5</span>
                  </div>
                )}
                {st.plain && (
                  <svg className="absolute top-0 right-0 z-10 w-7 h-8 drop-shadow-lg" viewBox="0 0 24 24"><path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" fill="#d4a574" stroke="#e4b584" strokeWidth={1.8} strokeLinejoin="round" /></svg>
                )}
              </div>
              <p className="mt-1 text-xs text-white/70">{st.label}</p>
            </div>
          );
        })}
      </div>
    </main>
  );
}
