import Link from 'next/link';
import type { TourCity } from '@/lib/data-tour-cities';

// "Tours by city" on the national-tours list (BRO-4723): the cities with the
// most tours still to come as chips, every city with a page behind a native
// <details> so this stays a server component. Each links to /tours/<city-st>.

const TOP_SHOWN = 12;

function shortCity(city: string) {
  return city.replace(/,\s*[A-Z]{2}$/, '');
}

const coming = (c: TourCity) => `${c.upcomingListed} tour${c.upcomingListed === 1 ? '' : 's'} coming`;

export default function ToursByCity({ cities }: { cities: TourCity[] }) {
  if (cities.length === 0) return null;
  const top = cities
    .filter(c => c.upcomingListed > 0)
    .sort((a, b) => b.upcomingListed - a.upcomingListed || a.city.localeCompare(b.city))
    .slice(0, TOP_SHOWN);
  // Portland, OR and Portland, ME both chipped: keep the state on both.
  const shortCounts = new Map<string, number>();
  for (const c of top) shortCounts.set(shortCity(c.city), (shortCounts.get(shortCity(c.city)) ?? 0) + 1);
  const chipName = (c: TourCity) => ((shortCounts.get(shortCity(c.city)) ?? 0) > 1 ? c.city : shortCity(c.city));
  const all = [...cities].sort((a, b) => a.city.localeCompare(b.city));

  return (
    <section className="mt-10 sm:mt-12 pt-6 sm:pt-8 border-t border-white/10" aria-labelledby="tours-by-city-heading">
      <h2 id="tours-by-city-heading" className="text-base sm:text-lg font-bold text-white mb-1">Tours by city</h2>
      <p className="text-sm text-gray-400 mb-3 sm:mb-4">What&apos;s playing near you, with dates and venues. Numbers are tours with dates still to come.</p>
      {top.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {top.map(c => (
            <li key={c.slug}>
              <Link
                href={`/tours/${c.slug}`}
                className="px-4 py-2.5 sm:py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors min-h-[44px] sm:min-h-0 flex items-center gap-2"
              >
                {chipName(c)}
                <span className="text-xs text-gray-400" aria-label={coming(c)} title={coming(c)}>{c.upcomingListed}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {all.length > top.length && (
        <details className="mt-4 group">
          <summary className="cursor-pointer text-sm font-medium text-brand hover:text-brand-hover list-none py-2">
            <span className="group-open:hidden">See all {all.length} cities</span>
            <span className="hidden group-open:inline">Hide cities</span>
          </summary>
          <ul className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6">
            {all.map(c => (
              <li key={c.slug} className="border-b border-white/5">
                <Link href={`/tours/${c.slug}`} className="flex items-baseline justify-between gap-3 py-2.5 text-sm text-gray-300 hover:text-white transition-colors">
                  <span className="truncate">{c.city}</span>
                  <span className="text-xs text-gray-400 whitespace-nowrap">{c.upcomingListed > 0 ? coming(c) : 'Recent stops'}</span>
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
