import type { ShowCastChanges, CastEvent } from '@/lib/data-types';

interface CastUpdatesCardProps {
  castChanges: ShowCastChanges;
  showStatus: string;
}

function PersonIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}

// Use UTC-based formatting to avoid timezone-related hydration mismatch
function formatEventDate(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function getEventConfig(event: CastEvent): {
  colorClass: string;
  bgClass: string;
  borderClass: string;
  icon: React.ReactNode;
  label: string;
} {
  switch (event.type) {
    case 'departure':
      return {
        colorClass: 'text-rose-400',
        bgClass: 'bg-rose-500/15',
        borderClass: 'border-rose-500/20',
        icon: <ArrowLeftIcon />,
        label: 'Departing',
      };
    case 'arrival':
      return {
        colorClass: 'text-emerald-400',
        bgClass: 'bg-emerald-500/15',
        borderClass: 'border-emerald-500/20',
        icon: <ArrowRightIcon />,
        label: event.endDate ? 'Joining (Limited)' : 'Joining',
      };
    case 'absence':
      return {
        colorClass: 'text-amber-400',
        bgClass: 'bg-amber-500/15',
        borderClass: 'border-amber-500/20',
        icon: <CalendarIcon />,
        label: 'Out',
      };
    case 'note':
      return {
        colorClass: 'text-blue-400',
        bgClass: 'bg-blue-500/15',
        borderClass: 'border-blue-500/20',
        icon: <CalendarIcon />,
        label: 'Update',
      };
  }
}

function CastEventRow({ event }: { event: CastEvent }) {
  const config = getEventConfig(event);

  return (
    <div className={`${config.bgClass} border ${config.borderClass} rounded-lg p-3 sm:p-4`}>
      <div className="flex items-start gap-3">
        {/* Type indicator */}
        <div className={`flex-shrink-0 mt-0.5 ${config.colorClass}`}>
          {config.icon}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Name & role */}
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {event.name ? (
              <span className="text-white font-semibold text-sm">{event.name}</span>
            ) : null}
            <span className={`text-xs font-medium ${config.colorClass}`}>{config.label}</span>
            {event.role && (
              <span className="text-gray-500 text-xs">as {event.role}</span>
            )}
          </div>

          {/* Date info */}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
            {event.date && (
              <span>
                {formatEventDate(event.date)}
                {event.endDate && ` \u2013 ${formatEventDate(event.endDate)}`}
              </span>
            )}
            {event.dates && event.dates.length > 0 && (
              <span>{event.dates.map(formatEventDate).join(', ')}</span>
            )}
          </div>

          {/* Note */}
          {event.note && (
            <p className="mt-1 text-xs text-gray-400 leading-relaxed">{event.note}</p>
          )}

          {/* Source link */}
          {event.sourceUrl && (
            <a
              href={event.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex items-center gap-1 mt-1.5 text-xs ${config.colorClass} hover:brightness-125 transition-all`}
            >
              Source
              <ExternalLinkIcon />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CastUpdatesCard({ castChanges, showStatus }: CastUpdatesCardProps) {
  // Don't show for closed shows
  if (showStatus === 'closed') return null;

  const upcoming = castChanges.upcoming || [];

  // Don't render if nothing upcoming
  if (upcoming.length === 0) return null;

  // Sort: departures first (people want to know who's leaving), then arrivals, absences, notes
  // Within each type, sort by date ascending
  const typeOrder: Record<string, number> = { departure: 0, arrival: 1, absence: 2, note: 3 };
  const sorted = [...upcoming].sort((a, b) => {
    const typeA = typeOrder[a.type] ?? 4;
    const typeB = typeOrder[b.type] ?? 4;
    if (typeA !== typeB) return typeA - typeB;
    if (a.date && b.date) return a.date.localeCompare(b.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });

  return (
    <section className="card p-5 sm:p-6 mb-6" aria-labelledby="cast-updates-heading">
      <h2 id="cast-updates-heading" className="text-lg font-bold text-white mb-4 flex items-center gap-2">
        <PersonIcon />
        Cast Updates
      </h2>

      <div className="space-y-3">
        {sorted.map((event, i) => (
          <CastEventRow key={`${event.type}-${event.name}-${event.date || i}`} event={event} />
        ))}
      </div>
    </section>
  );
}
