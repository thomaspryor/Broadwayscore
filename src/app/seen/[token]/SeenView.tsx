'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import Link from 'next/link';
import MiniStars from '@/components/user/Stars';
import { PosterGridCard, SectionBand, UpcomingListRow, ViewModeToggle, type ViewMode } from '@/components/user/upcoming-cards';
import { trackSharedDiary } from '@/lib/shared-diary/events';
import { diarySummary, diaryTitle, type SeenEntryView, type SharedDiaryView } from '@/lib/shared-diary/view-model';

/**
 * Display-only view of someone's shared theater diary (BRO-4566). Built from
 * the same pieces as My Shows → Diary (src/components/user/upcoming-cards.tsx
 * and Stars): year bands, poster grid with the date pill and gold stars, the
 * iOS-style list rows, the grid/list switch. Everything is resolved on the
 * server; this fetches nothing.
 */
/** Everything a grid card shows, for screen readers: the link wraps it all. */
function entryLabel(e: SeenEntryView): string {
  const parts = [`View ${e.title}`];
  if (e.dateLabel) parts.push(`seen ${e.dateLabel}`);
  if (e.rating > 0) parts.push(`${e.rating} out of 5 stars`);
  return parts.join(', ');
}

export default function SeenView({ view }: { view: SharedDiaryView }) {
  const [mode, setMode] = useState<ViewMode>('grid');
  const empty = view.groups.length === 0;

  // Fired on mount: link-preview crawlers don't run JavaScript, so this
  // counts people. The ref keeps it to one per page view (StrictMode).
  const viewed = useRef(false);
  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    trackSharedDiary({ name: 'diary_page_viewed', props: { shows: view.showsSeen, notes: view.showText } });
  }, [view.showsSeen, view.showText]);

  const onShowClick = (e: MouseEvent<HTMLElement>) => {
    const a = (e.target as HTMLElement).closest('a');
    const showId = (e.target as HTMLElement).closest<HTMLElement>('[data-show-id]')?.dataset.showId;
    if (!a || !showId) return;
    trackSharedDiary({ name: 'diary_show_tapped', props: { show_id: showId } });
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-4 sm:pt-8 pb-12" data-testid="shared-diary">
      <header className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white break-words">{diaryTitle(view.name)}</h1>
          {!empty && <p className="text-sm text-gray-400 mt-1" data-testid="diary-count">{diarySummary(view.showsSeen)}</p>}
        </div>
        {!empty && <ViewModeToggle value={mode} onChange={setMode} />}
      </header>

      {empty && (
        <div className="card p-card-lg text-center" data-testid="diary-empty">
          <p className="text-white font-semibold mb-1">{view.name} hasn&apos;t logged any shows yet.</p>
          <p className="text-sm text-gray-400 mb-4">Check back later, or see what&apos;s playing.</p>
          <Link href="/" className="btn btn-secondary">See what&apos;s playing</Link>
        </div>
      )}

      <div onClickCapture={onShowClick}>
        {view.groups.map(g => {
          const id = `diary-${g.year ?? 'undated'}`;
          return (
            <section key={id} className="mb-8" aria-labelledby={id} data-testid="diary-year">
              <SectionBand as="h2" id={id} title={g.year ?? 'No date'} count={g.entries.length} />
              {mode === 'grid' ? (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {g.entries.map((e, i) => (
                    <div key={`${e.showId}-${i}`} data-show-id={e.showId} data-testid="diary-item">
                      <PosterGridCard
                        href={e.href}
                        posterUrl={e.posterUrl}
                        date={e.dateLabel}
                        title={e.title}
                        ariaLabel={entryLabel(e)}
                        meta={
                          <div className="mt-1.5 flex justify-center gap-0.5 min-h-[18px]" aria-hidden="true">
                            {e.rating > 0 && <MiniStars rating={e.rating} size="md" filledOnly />}
                          </div>
                        }
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {g.entries.map((e, i) => (
                    <div key={`${e.showId}-${i}`} data-show-id={e.showId} data-testid="diary-item">
                      <UpcomingListRow
                        href={e.href}
                        posterUrl={e.posterUrl}
                        title={e.title}
                        venue={e.venue}
                        plannedDate={e.date}
                        note={null}
                        extra={e.rating > 0 ? (
                          <div className="flex gap-0.5 pointer-events-none" aria-label={`${e.rating} out of 5 stars`} role="img">
                            <MiniStars rating={e.rating} size="sm" filledOnly />
                          </div>
                        ) : null}
                      />
                    </div>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {view.capped && (
        <p className="text-xs text-gray-500 text-center mb-4" data-testid="diary-capped">Showing the most recent 1,000 entries.</p>
      )}

      <p className="text-sm text-gray-400 text-center">
        <Link href="/" className="inline-block py-3 text-brand hover:text-brand-light underline underline-offset-2">
          Keep your own theater diary on Broadway Scorecard
        </Link>
      </p>
    </div>
  );
}
