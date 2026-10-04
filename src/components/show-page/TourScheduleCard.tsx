import { StatusBadge } from '@/components/show-cards';
import { formatShowDate } from '@/lib/date-utils';
import { stopKey, type TourStop } from '@/lib/tour-schedule';

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

function StopRow({ stop, isNow, past, reviewCount }: { stop: TourStop; isNow: boolean; past: boolean; reviewCount: number }) {
  return (
    <li className={`flex items-baseline gap-3 py-2 border-b border-white/5 last:border-b-0 ${past ? 'opacity-60' : ''}`}>
      <span className="w-24 shrink-0 text-xs text-gray-500 tabular-nums">{range(stop)}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm text-white truncate">{stop.city}</span>
        <span className="block text-xs text-gray-500 truncate">{stop.venue}</span>
      </span>
      {isNow ? <StatusBadge status="open" /> : reviewCount > 0 ? (
        <span className="text-[11px] text-gray-400 whitespace-nowrap">{reviewCount} review{reviewCount > 1 ? 's' : ''}</span>
      ) : null}
    </li>
  );
}

export default function TourScheduleCard({ stops, today, reviewCounts, source }: {
  stops: TourStop[];
  today: string;
  /** Reviews per stop, keyed by stopKey(). */
  reviewCounts: Record<string, number>;
  source?: string | null;
}) {
  if (stops.length === 0) return null;
  const nowIdx = stops.findIndex(s => s.start <= today && today <= s.end);
  const firstAhead = stops.findIndex(s => s.start > today);
  const ahead = firstAhead === -1 ? [] : stops.slice(firstAhead, firstAhead + UPCOMING_SHOWN);
  const shown = [...(nowIdx >= 0 ? [stops[nowIdx]] : []), ...ahead];
  const row = (s: TourStop) => (
    <StopRow key={`${s.city}|${s.start}`} stop={s} isNow={s === stops[nowIdx]} past={s.end < today} reviewCount={reviewCounts[stopKey(s)] ?? 0} />
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
          Dates from <a href={source} target="_blank" rel="noopener noreferrer" className="hover:text-brand-hover transition-colors">Tours To You</a>. Check the venue for showtimes and tickets.
        </p>
      )}
    </section>
  );
}
