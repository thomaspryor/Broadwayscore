import Link from 'next/link';
import { StatusBadge } from '@/components/show-cards';
import TicketLink from '@/components/TicketLink';
import { formatShowDate } from '@/lib/date-utils';
import { stopKey, type TourStop } from '@/lib/tour-schedule';
import { citySlug } from '@/lib/tour-cities';

// A national tour's engagements (BRO-4601). Same card chrome as the Critic
// Scorecard and Quick Facts: eyebrow header, then rows. Shows where the tour
// is now and the next few stops; the full list (past stops with their review
// counts) sits behind a native <details>, so this stays a server component.

const UPCOMING_SHOWN = 4;

function range(s: TourStop) {
  const sameMonth = s.start.slice(0, 7) === s.end.slice(0, 7);
  const start = formatShowDate(s.start, { month: 'short', day: 'numeric' });
  const end = sameMonth ? String(Number(s.end.slice(8, 10))) : formatShowDate(s.end, { month: 'short', day: 'numeric' });
  return s.start === s.end ? start : `${start}–${end}`;
}

interface TicketShow { id: string; title: string; slug: string; status: string }

function StopRow({ stop, isNow, past, reviewCount, ticketUrl, show, cityHref }: {
  stop: TourStop; isNow: boolean; past: boolean; reviewCount: number; ticketUrl?: string; show?: TicketShow; cityHref?: string;
}) {
  return (
    <li className={`flex items-baseline gap-3 py-2 border-b border-white/5 last:border-b-0 ${past ? 'opacity-60' : ''}`}>
      <span className="w-24 shrink-0 text-xs text-gray-500 tabular-nums">{range(stop)}</span>
      <span className="flex-1 min-w-0">
        {cityHref ? (
          <Link href={cityHref} className="block py-0.5 text-sm text-white underline decoration-white/40 underline-offset-4 hover:text-brand-hover hover:decoration-brand-hover break-words transition-colors">{stop.city}</Link>
        ) : (
          <span className="block text-sm text-white break-words">{stop.city}</span>
        )}
        <span className="block text-xs text-gray-500 truncate">{stop.venue}</span>
      </span>
      {isNow ? <StatusBadge status="open" /> : reviewCount > 0 ? (
        <span className="text-[11px] text-gray-400 whitespace-nowrap">{reviewCount} review{reviewCount > 1 ? 's' : ''}</span>
      ) : null}
      {ticketUrl && show && !past && (
        <TicketLink
          showName={show.title} showId={show.id} showSlug={show.slug} showStatus={show.status} showCategory="tour"
          platform="TodayTix" url={ticketUrl} pageType="show"
          className="text-[11px] font-medium text-amber-400/80 hover:text-amber-300 whitespace-nowrap"
        >
          Tickets ↗
        </TicketLink>
      )}
    </li>
  );
}

export default function TourScheduleCard({ stops, today, reviewCounts, source, tickets = {}, show, cityPages }: {
  stops: TourStop[];
  today: string;
  /** Reviews per stop, keyed by stopKey(). */
  reviewCounts: Record<string, number>;
  source?: string | null;
  /** TodayTix links for stops on sale there, keyed by stopKey(). */
  tickets?: Record<string, string>;
  /** For ticket-click tracking. */
  show?: TicketShow;
  /** Slugs of the /tours/<city> pages that exist: those cities link there. */
  cityPages?: ReadonlySet<string>;
}) {
  if (stops.length === 0) return null;
  // A closed tour has no current or next stop, whatever the schedule says.
  const closed = show?.status === 'closed';
  const nowIdx = closed ? -1 : stops.findIndex(s => s.start <= today && today <= s.end);
  const firstAhead = closed ? -1 : stops.findIndex(s => s.start > today);
  const ahead = firstAhead === -1 ? [] : stops.slice(firstAhead, firstAhead + UPCOMING_SHOWN);
  const shown = [...(nowIdx >= 0 ? [stops[nowIdx]] : []), ...ahead];
  const row = (s: TourStop) => (
    <StopRow key={`${s.city}|${s.start}`} stop={s} isNow={s === stops[nowIdx]} past={s.end < today} reviewCount={reviewCounts[stopKey(s)] ?? 0} ticketUrl={tickets[stopKey(s)]} show={show} cityHref={cityPages?.has(citySlug(s.city)) ? `/tours/${citySlug(s.city)}` : undefined} />
  );

  return (
    <section id="tour-schedule" className="card p-5 sm:p-6 pb-4 sm:pb-5 mb-5 sm:mb-8 scroll-mt-20" aria-labelledby="tour-schedule-heading">
      <header className="flex items-center justify-between gap-3 mb-2">
        <h2 id="tour-schedule-heading" className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">Tour Schedule</h2>
        <span className="text-[11px] font-medium tracking-[0.06em] text-gray-500 lowercase shrink-0">{stops.length} stops</span>
      </header>
      {shown.length > 0 ? <ul>{shown.map(row)}</ul> : <p className="text-sm text-gray-400 py-2">The tour has played its last scheduled stop.</p>}
      <details className="mt-2 group">
        <summary className="cursor-pointer text-sm font-medium text-brand hover:text-brand-hover list-none py-2">
          <span className="group-open:hidden">See all {stops.length} stops</span>
          <span className="hidden group-open:inline">Hide full schedule</span>
        </summary>
        <ul>{stops.map(row)}</ul>
      </details>
      {source && (
        <p className="mt-3 pt-3 border-t border-white/5 text-xs text-gray-500">
          Dates from <a href={source} target="_blank" rel="noopener noreferrer" className="hover:text-brand-hover transition-colors">Tours To You</a>. {Object.keys(tickets).length ? 'Tickets for some stops through TodayTix; check the venue for the rest.' : 'Check the venue for showtimes and tickets.'}
        </p>
      )}
    </section>
  );
}
