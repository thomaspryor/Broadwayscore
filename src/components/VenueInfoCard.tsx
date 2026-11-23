import type { Theater } from '@/lib/data-types';
import AccessibilityBadges, { hasAccessibilityFacts } from './AccessibilityBadges';
import SeatViewLinks, { hasSeatViewLinks } from './SeatViewLinks';

/**
 * Verified venue facts for Off-Broadway and London venue pages (BRO-8088): address with
 * directions, official website, seats, year opened, operator. Values come from
 * data/venue-info.json (a field exists only when two independent sources agreed); when a
 * venue has no verified address the page's existing shows.json address is shown instead.
 * Also shows access facts and seat-view links when verified (BRO-8112): access facts only when the
 * venue's own page states them, seat links only when they resolve to this venue's page.
 * Renders nothing when there is nothing to show.
 */
function mapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

type VenueFacts = Pick<Theater, 'name' | 'address' | 'website' | 'capacity' | 'yearBuilt' | 'operator' | 'accessibility' | 'externalLinks'>;

export default function VenueInfoCard({ theater }: { theater: VenueFacts }) {
  const rows: { label: string; value: React.ReactNode }[] = [];

  if (theater.address) {
    rows.push({
      label: 'Address',
      value: (
        <>
          <span className="text-gray-200">{theater.address}</span>
          <a
            href={mapsUrl(theater.address)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-xs text-brand hover:underline sm:mt-0.5"
          >
            Get directions<span className="sr-only"> (opens in a new tab)</span>
          </a>
        </>
      ),
    });
  }
  if (theater.website) {
    rows.push({
      label: 'Website',
      value: (
        <a href={theater.website} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline break-all">
          {displayHost(theater.website)}
          <span className="sr-only"> (official website, opens in a new tab)</span>
        </a>
      ),
    });
  }
  if (theater.capacity) {
    rows.push({ label: 'Seats', value: <span className="text-gray-200">{theater.capacity.toLocaleString('en-US')}</span> });
  }
  if (theater.yearBuilt) {
    rows.push({ label: 'Year opened', value: <span className="text-gray-200">{theater.yearBuilt}</span> });
  }
  if (theater.operator) {
    rows.push({ label: 'Run by', value: <span className="text-gray-200">{theater.operator}</span> });
  }

  const showAccess = hasAccessibilityFacts(theater.accessibility);
  const showSeats = hasSeatViewLinks(theater.externalLinks);
  if (rows.length === 0 && !showAccess && !showSeats) return null;

  return (
    <section className="card p-4 mb-4 border border-white/5" aria-labelledby="venue-info-heading">
      <h2 id="venue-info-heading" className="text-xs font-medium uppercase tracking-wider text-fg-muted mb-3">
        Venue info
      </h2>
      {rows.length > 0 && (
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 sm:gap-y-3 text-sm">
        {rows.map(r => (
          <div key={r.label} className="min-w-0">
            <dt className="text-[11px] uppercase tracking-wider text-fg-muted">{r.label}</dt>
            <dd className="mt-0.5">{r.value}</dd>
          </div>
        ))}
      </dl>
      )}
      {showAccess && <AccessibilityBadges accessibility={theater.accessibility} className="border-t border-white/5 pt-3 mt-3" />}
      {showSeats && <SeatViewLinks externalLinks={theater.externalLinks} className="border-t border-white/5 pt-3 mt-3" />}
    </section>
  );
}
