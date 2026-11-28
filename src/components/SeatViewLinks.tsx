import type { TheaterExternalLinks } from '@/lib/data-types';

/**
 * "Find Your Seat" links to a venue's own SeatPlan / A View From My Seat pages. Shared by the
 * Broadway Theater Scorecard and the Off-Broadway / London VenueInfoCard (BRO-8112). Callers only
 * pass links that resolved to that venue's page.
 */
function ExternalLinkIcon() {
  return (
    <svg className="w-3 h-3 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}

const LINK = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white text-xs font-medium transition-colors';

export function hasSeatViewLinks(l?: TheaterExternalLinks): boolean {
  return !!(l && (l.seatplan || l.aviewfrommyseat));
}

export default function SeatViewLinks({ externalLinks, className = 'border-t border-white/5 pt-3' }: { externalLinks?: TheaterExternalLinks; className?: string }) {
  if (!externalLinks || !hasSeatViewLinks(externalLinks)) return null;
  return (
    <div className={className}>
      <p className="text-[10px] text-fg-muted uppercase tracking-wider font-semibold mb-2">Find Your Seat</p>
      <div className="flex flex-wrap gap-2">
        {externalLinks.seatplan && (
          <a href={externalLinks.seatplan} target="_blank" rel="noopener noreferrer" className={LINK}>
            SeatPlan <ExternalLinkIcon />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
        {externalLinks.aviewfrommyseat && (
          <a href={externalLinks.aviewfrommyseat} target="_blank" rel="noopener noreferrer" className={LINK}>
            A View From My Seat <ExternalLinkIcon />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
      </div>
    </div>
  );
}
