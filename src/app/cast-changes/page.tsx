import Link from 'next/link';
import { Metadata } from 'next';
import { getAllShows } from '@/lib/data-core';
import { getCastChanges, getCastChangesLastUpdated, getAllCastChangeShowIds } from '@/lib/data-cast';
import type { CastEvent } from '@/lib/data-types';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import ShowImage from '@/components/ShowImage';

export const metadata: Metadata = {
  title: 'Broadway Cast Changes - Upcoming Departures, Arrivals & Stunt Casting',
  description: 'Track upcoming Broadway cast changes across all open shows. Find out who\'s leaving, who\'s joining, and which stars are doing limited engagements.',
  alternates: {
    canonical: `${BASE_URL}/cast-changes`,
  },
  openGraph: {
    title: 'Broadway Cast Changes - Who\'s Coming & Going',
    description: 'Track upcoming Broadway cast changes. Departures, arrivals, limited engagements, and stunt casting across all open shows.',
    url: `${BASE_URL}/cast-changes`,
    type: 'article',
  },
};

function PersonIcon({ className }: { className?: string }) {
  return (
    <svg className={className || "w-5 h-5"} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
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

function formatEventDate(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function getEventConfig(event: CastEvent) {
  switch (event.type) {
    case 'departure':
      return { colorClass: 'text-rose-400', bgClass: 'bg-rose-500/15', borderClass: 'border-rose-500/20', icon: <ArrowLeftIcon />, label: 'Departing' };
    case 'arrival':
      return { colorClass: 'text-emerald-400', bgClass: 'bg-emerald-500/15', borderClass: 'border-emerald-500/20', icon: <ArrowRightIcon />, label: event.endDate ? 'Joining (Limited)' : 'Joining' };
    case 'absence':
      return { colorClass: 'text-amber-400', bgClass: 'bg-amber-500/15', borderClass: 'border-amber-500/20', icon: <CalendarIcon />, label: 'Out' };
    case 'note':
      return { colorClass: 'text-blue-400', bgClass: 'bg-blue-500/15', borderClass: 'border-blue-500/20', icon: <CalendarIcon />, label: 'Update' };
  }
}

interface ShowWithCast {
  show: {
    id: string;
    slug: string;
    title: string;
    venue: string;
    status: string;
    type: string;
    images?: { thumbnail?: string; poster?: string; hero?: string };
    criticScore?: { score?: number | null; reviewCount?: number };
  };
  events: CastEvent[];
}

function ShowCastCard({ showWithCast, index }: { showWithCast: ShowWithCast; index: number }) {
  const { show, events } = showWithCast;
  const score = show.criticScore?.score;

  return (
    <div className="card p-4 sm:p-5 animate-in" style={{ animationDelay: `${index * 30}ms` }}>
      {/* Show header */}
      <Link href={`/show/${show.slug}`} className="group flex items-center gap-3 mb-4">
        <div className="flex-shrink-0 w-12 h-12 rounded-lg overflow-hidden bg-surface-overlay">
          <ShowImage
            sources={[
              show.images?.thumbnail ? getOptimizedImageUrl(show.images.thumbnail, 'thumbnail') : null,
              show.images?.poster ? getOptimizedImageUrl(show.images.poster, 'thumbnail') : null,
            ]}
            alt={show.title}
            width={48}
            height={48}
            className="w-full h-full object-cover"
            fallback={
              <div className="w-full h-full flex items-center justify-center text-gray-500">
                <span className="text-lg">🎭</span>
              </div>
            }
          />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-white text-base group-hover:text-brand transition-colors truncate">
            {show.title}
          </h3>
          <p className="text-xs text-gray-500">{show.venue}</p>
        </div>
        {score !== undefined && score !== null && (
          <div className={`flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold ${
            score >= 85 ? 'score-must-see' :
            score >= 75 ? 'score-great' :
            score >= 65 ? 'score-good' :
            score >= 55 ? 'score-tepid' :
            'score-skip'
          }`}>
            {Math.round(score)}
          </div>
        )}
      </Link>

      {/* Events */}
      <div className="space-y-2">
        {events.map((event, i) => {
          const config = getEventConfig(event);
          return (
            <div key={`${event.type}-${event.name}-${event.date || i}`} className={`${config.bgClass} border ${config.borderClass} rounded-lg p-3`}>
              <div className="flex items-start gap-2.5">
                <div className={`flex-shrink-0 mt-0.5 ${config.colorClass}`}>{config.icon}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    {event.name && <span className="text-white font-semibold text-sm">{event.name}</span>}
                    <span className={`text-xs font-medium ${config.colorClass}`}>{config.label}</span>
                    {event.role && <span className="text-gray-500 text-xs">as {event.role}</span>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
                    {event.date && (
                      <span>
                        {formatEventDate(event.date)}
                        {event.endDate && ` \u2013 ${formatEventDate(event.endDate)}`}
                      </span>
                    )}
                  </div>
                  {event.note && <p className="mt-0.5 text-xs text-gray-400">{event.note}</p>}
                  {event.sourceUrl && (
                    <a href={event.sourceUrl} target="_blank" rel="noopener noreferrer"
                      className={`inline-flex items-center gap-1 mt-1 text-xs ${config.colorClass} hover:brightness-125 transition-all`}>
                      Source <ExternalLinkIcon />
                    </a>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function CastChangesPage() {
  const allShows = getAllShows();
  const castChangeShowIds = getAllCastChangeShowIds();
  const lastUpdated = getCastChangesLastUpdated();

  // Build list of shows with their upcoming events, only open/previews
  const showsWithCast = castChangeShowIds
    .map(showId => {
      const show = allShows.find(s => s.id === showId);
      if (!show || show.status === 'closed') return null;

      const castData = getCastChanges(showId);
      if (!castData || !castData.upcoming || castData.upcoming.length === 0) return null;

      return { show, events: castData.upcoming } as ShowWithCast;
    })
    .filter((item): item is ShowWithCast => item !== null)
    .sort((a, b) => {
      // Sort by soonest event date first, shows without dates last
      const getEarliestDate = (events: CastEvent[]) => {
        const dates = events.filter(e => e.date).map(e => e.date!);
        return dates.length > 0 ? dates.sort()[0] : 'z';
      };
      return getEarliestDate(a.events).localeCompare(getEarliestDate(b.events));
    });

  // Stats
  const totalEvents = showsWithCast.reduce((sum, s) => sum + s.events.length, 0);
  const departures = showsWithCast.reduce((sum, s) => sum + s.events.filter(e => e.type === 'departure').length, 0);
  const arrivals = showsWithCast.reduce((sum, s) => sum + s.events.filter(e => e.type === 'arrival').length, 0);

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Cast Changes', url: `${BASE_URL}/cast-changes` },
  ]);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema]) }}
      />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {/* Back Link */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Shows
        </Link>

        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white flex items-center gap-3">
            <PersonIcon className="w-8 h-8 text-gray-400" />
            Broadway Cast Changes
          </h1>
          <p className="text-gray-400 mt-2">
            Upcoming cast departures, arrivals, and limited engagements across currently running Broadway shows.
          </p>
          <p className="text-sm text-gray-500 mt-1">
            {showsWithCast.length} shows with updates · Last updated {new Date(lastUpdated).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-rose-400">{departures}</div>
            <div className="text-xs text-gray-500 mt-1">Departures</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-emerald-400">{arrivals}</div>
            <div className="text-xs text-gray-500 mt-1">Arrivals</div>
          </div>
          <div className="card p-4 text-center">
            <div className="text-2xl font-bold text-white">{totalEvents}</div>
            <div className="text-xs text-gray-500 mt-1">Total Updates</div>
          </div>
        </div>

        {/* Show Cards */}
        {showsWithCast.length > 0 ? (
          <div className="space-y-4">
            {showsWithCast.map((item, index) => (
              <ShowCastCard key={item.show.id} showWithCast={item} index={index} />
            ))}
          </div>
        ) : (
          <div className="card p-8 text-center">
            <PersonIcon className="w-12 h-12 text-gray-600 mx-auto mb-3" />
            <p className="text-gray-400">No upcoming cast changes tracked yet.</p>
            <p className="text-sm text-gray-500 mt-1">Cast changes are updated weekly from Playbill, BroadwayWorld, and official show sites.</p>
          </div>
        )}

        {/* Data Source Note */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6 mt-8">
          <p>
            Cast change data sourced from Playbill, BroadwayWorld, official show websites, and r/Broadway.
            Updated weekly. Only star-level changes are tracked. Information may not reflect last-minute absences or understudies.
          </p>
        </div>
      </div>
    </>
  );
}
