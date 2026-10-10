'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import Link from 'next/link';
import AddToCalendarButtons from '@/components/user/AddToCalendarButtons';
import {
  SectionBand, UpcomingGridCard, UpcomingListRow, ViewModeToggle, bookabilityLabel, type ViewMode,
} from '@/components/user/upcoming-cards';
import { trackSharedPlans } from '@/lib/shared-plans/events';
import { plansTitle, type BookedPlanView, type SharedPlansView as View } from '@/lib/shared-plans/view-model';

/**
 * Display-only view of someone's shared plans (BRO-4481). Built from the same
 * pieces as My Shows → Upcoming (src/components/user/upcoming-cards.tsx):
 * poster grid with the amber date, list rows with the date and day countdown,
 * the Watchlist status badge, the grid/list switch, and the site's
 * AddToCalendarButtons (labeled button + Apple/Google sheet). Everything is resolved on the server; this fetches
 * nothing.
 */
export default function SharedPlansView({ view }: { view: View }) {
  const [mode, setMode] = useState<ViewMode>('grid');
  const empty = view.booked.length === 0 && view.unbooked.length === 0;

  // Fired on mount: link-preview crawlers (iMessage, WhatsApp) don't run
  // JavaScript, so this counts people, including those who never scroll.
  // The ref keeps it to one per page view (React StrictMode re-runs effects).
  const viewed = useRef(false);
  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    trackSharedPlans({ name: 'plans_page_viewed', props: { booked: view.counts.booked, unbooked: view.counts.unbooked } });
  }, [view.counts.booked, view.counts.unbooked]);

  // One click handler per section for show taps. Calendar picks are tracked
  // by AddToCalendarButtons' onAdd: its sheet is portaled out of the section,
  // so a DOM lookup for [data-show-id] finds nothing there (and returns here).
  const onSectionClick = (section: 'booked' | 'unbooked') => (e: MouseEvent<HTMLElement>) => {
    const a = (e.target as HTMLElement).closest('a');
    const showId = (e.target as HTMLElement).closest<HTMLElement>('[data-show-id]')?.dataset.showId;
    if (!a || !showId) return;
    trackSharedPlans({ name: 'plans_show_tapped', props: { show_id: showId, section } });
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-4 sm:pt-8 pb-12" data-testid="shared-plans">
      <header className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl sm:text-3xl font-extrabold text-white">{plansTitle(view.name)}</h1>
        {!empty && <ViewModeToggle value={mode} onChange={setMode} />}
      </header>

      {empty && (
        <div className="card p-card-lg text-center" data-testid="plans-empty">
          <p className="text-white font-semibold mb-1">{view.name} has nothing planned right now.</p>
          <p className="text-sm text-gray-400 mb-4">Check back later, or see what&apos;s playing.</p>
          <Link href="/" className="btn btn-secondary">See what&apos;s playing</Link>
        </div>
      )}

      {view.booked.length > 0 && (
        <section className="mb-8" aria-labelledby="plans-booked" data-testid="plans-booked" onClickCapture={onSectionClick('booked')}>
          <SectionBand as="h2" id="plans-booked" title="Upcoming" count={view.booked.length} noun="show" />
          {mode === 'grid' ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {view.booked.map(p => (
                <div key={p.id} data-show-id={p.id} data-testid="plans-booked-item">
                  <UpcomingGridCard
                    href={p.href}
                    posterUrl={p.posterUrl}
                    date={p.dateLabel}
                    title={p.title}
                    footer={<BookedCalendar plan={p} />}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {view.booked.map(p => (
                <div key={p.id} data-show-id={p.id} data-testid="plans-booked-item">
                  <UpcomingListRow
                    href={p.href}
                    posterUrl={p.posterUrl}
                    title={p.title}
                    venue={p.venue}
                    plannedDate={p.date}
                    extra={<BookedCalendar plan={p} inList />}
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {view.unbooked.length > 0 && (
        <section className="mb-8" aria-labelledby="plans-unbooked" data-testid="plans-unbooked" onClickCapture={onSectionClick('unbooked')}>
          <SectionBand as="h2" id="plans-unbooked" title="Not yet booked" count={view.unbooked.length} noun="show" />
          {mode === 'grid' ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {view.unbooked.map(s => (
                <div key={s.id} data-show-id={s.id}>
                  <UpcomingGridCard href={s.href} posterUrl={s.posterUrl} date={null} title={s.title} badge={bookabilityLabel(s.bookability)} />
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {view.unbooked.map(s => {
                const badge = bookabilityLabel(s.bookability);
                return (
                  <div key={s.id} data-show-id={s.id}>
                    <UpcomingListRow
                      href={s.href}
                      posterUrl={s.posterUrl}
                      title={s.title}
                      venue={s.venue}
                      note={badge ? <span className={`inline-block px-1.5 py-0.5 text-[9px] font-bold uppercase rounded ${badge.cls}`}>{badge.text}</span> : null}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      <p className="text-sm text-gray-400 text-center">
        <Link href="/" className="inline-block py-3 text-brand hover:text-brand-light underline underline-offset-2">
          Make your own list on Broadway Scorecard
        </Link>
      </p>
    </div>
  );
}

/** Grid: full card width under the date. List: under the date and countdown,
 *  the width of that column, so the show title keeps its room. */
function BookedCalendar({ plan, inList }: { plan: BookedPlanView; inList?: boolean }) {
  return (
    <div className={inList ? 'w-24 ml-auto mt-1.5' : 'mt-1.5'} data-testid="plans-calendar">
      <AddToCalendarButtons
        event={plan.event}
        compact
        onAdd={method => trackSharedPlans({ name: 'plans_calendar_added', props: { show_id: plan.id, method } })}
      />
    </div>
  );
}
