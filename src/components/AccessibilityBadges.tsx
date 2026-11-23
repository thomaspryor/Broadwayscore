import type { TheaterAccessibility } from '@/lib/data-types';

/**
 * Accessibility badges for a venue, shared by the Broadway Theater Scorecard and the
 * Off-Broadway / London VenueInfoCard (BRO-8112). Green pills for what the venue offers; a muted
 * pill only when the venue's own page says it does NOT offer something. Silence shows nothing.
 * `sourceUrl` links the official page the facts came from.
 */
function WheelchairIcon() {
  return (
    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2a3 3 0 100 6 3 3 0 000-6zm-1 8a5 5 0 00-4.9 4H4a1 1 0 100 2h2.1A5 5 0 0016 16h3l1.4 4.2a1 1 0 101.9-.6L20.7 15a1 1 0 00-.9-.7L16 14a3 3 0 01-3-3V10h-2z" />
    </svg>
  );
}

const LABELS = {
  wheelchair: 'Wheelchair',
  stepFree: 'Step-free',
  elevator: 'Elevator',
  hearingLoop: 'Hearing Loop',
  assistiveListening: 'Assistive Listening',
} as const;
type Flag = keyof typeof LABELS;
// Wording for the muted "No ..." pill: reads unambiguously on its own.
const DENIED: Record<Flag, string> = {
  wheelchair: 'wheelchair access',
  stepFree: 'step-free access',
  elevator: 'elevator',
  hearingLoop: 'hearing loop',
  assistiveListening: 'assistive listening',
};
const ORDER: Flag[] = ['wheelchair', 'stepFree', 'elevator', 'hearingLoop', 'assistiveListening'];

/** ", checked Nov 2026" from an ISO date; empty when the date is missing or unreadable. */
function checkedLabel(iso?: string): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(iso || '');
  if (!m) return '';
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1];
  return month ? `, checked ${month} ${m[1]}` : '';
}

const PILL = 'inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium border';

export function hasAccessibilityFacts(a?: TheaterAccessibility): boolean {
  return !!(a && a.verified && (ORDER.some(f => a[f]) || (a.denied && a.denied.length > 0)));
}

export default function AccessibilityBadges({ accessibility, className = 'border-t border-white/5 pt-3 mb-3' }: { accessibility?: TheaterAccessibility; className?: string }) {
  if (!accessibility || !hasAccessibilityFacts(accessibility)) return null;
  const denied = accessibility.denied ?? [];
  return (
    <div className={className}>
      <p className="text-[10px] text-fg-muted uppercase tracking-wider font-semibold mb-2">Accessibility</p>
      <div className="flex flex-wrap gap-1.5">
        {ORDER.filter(f => accessibility[f]).map(f => (
          <span key={f} className={`${PILL} bg-status-open-bg text-status-open border-status-open/20`}>
            {f === 'wheelchair' && <WheelchairIcon />} {LABELS[f]}
          </span>
        ))}
        {ORDER.filter(f => denied.includes(f)).map(f => (
          <span key={`no-${f}`} className={`${PILL} bg-surface-overlay text-fg-muted border-white/10`}>
            No {DENIED[f]}
          </span>
        ))}
      </div>
      {accessibility.notes && (
        <p className="text-xs text-fg-muted mt-1.5">{accessibility.notes}</p>
      )}
      {accessibility.sourceUrl && (
        <p className="text-[10px] text-fg-muted mt-1.5">
          <a href={accessibility.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
            Source: the venue&apos;s access page<span className="sr-only"> (opens in a new tab)</span>
          </a>
          {checkedLabel(accessibility.checkedAt)}. Check with the box office before you book.
        </p>
      )}
    </div>
  );
}
