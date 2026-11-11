import type { ReviewArrival } from '@/lib/review-arrival';

/** Three visual options for the opening-night status (BRO-7376). Owner picks one; the rest get deleted. */
export type ReviewArrivalVariant = 'a' | 'b' | 'c';

function headline(a: ReviewArrival): string {
  const n = a.reviewCount;
  switch (a.phase) {
    case 'waiting':
      return `Opening night. Critics file tonight, about ${a.expected} reviews usually land within 3 days.`;
    case 'below-minimum':
      return `${n} of about ${a.expected} reviews in. A score appears once enough are in.`;
    case 'nearly-complete':
      return n >= a.expected
        ? `${n} reviews in, about the usual ${a.expected}. Late ones may still land.`
        : `Nearly all in: ${n} of about ${a.expected} reviews. A few more may land.`;
    default:
      return `${n} of about ${a.expected} reviews in. The score can still move.`;
  }
}

function Outlets({ a }: { a: ReviewArrival }) {
  const total = a.regularIn.length + a.regularToCome.length;
  if (total === 0 || a.phase === 'waiting') return null;
  return (
    <p className="text-xs text-fg-muted leading-snug" data-testid="review-arrival-outlets">
      <span className="text-gray-300 font-semibold">Regular outlets {a.regularIn.length} of {total}.</span>{' '}
      {a.regularToCome.length > 0 ? <>Still to come: {a.regularToCome.map((o) => o.name).join(', ')}.</> : 'All in.'}
    </p>
  );
}

function pct(a: ReviewArrival): number {
  return Math.max(2, Math.min(100, Math.round((a.reviewCount / a.expected) * 100)));
}

export default function ReviewArrivalStatus({ arrival, variant = 'a' }: { arrival: ReviewArrival; variant?: ReviewArrivalVariant }) {
  const text = headline(arrival);
  const tone = arrival.phase === 'nearly-complete' ? 'bg-status-open' : 'bg-score-tepid';
  if (variant === 'c') {
    return (
      <div className="flex flex-col gap-1.5" data-testid="review-arrival" data-phase={arrival.phase}>
        <span className="inline-flex items-center gap-2 self-start rounded-full bg-surface-overlay px-3 py-1 text-xs font-semibold text-gray-300">
          <span className={`w-2 h-2 rounded-full ${tone} animate-pulse`} aria-hidden="true" />
          {arrival.phase === 'waiting' ? 'Reviews expected tonight' : `Still arriving · ${arrival.reviewCount} of ~${arrival.expected}`}
        </span>
        <p className="text-xs text-fg-muted leading-snug">{text}</p>
        <Outlets a={arrival} />
      </div>
    );
  }
  if (variant === 'b') {
    return (
      <div className="card p-3 flex flex-col gap-2" data-testid="review-arrival" data-phase={arrival.phase}>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold text-gray-300 uppercase tracking-wide">Reviews still arriving</p>
          <p className="text-xs text-fg-muted whitespace-nowrap">{arrival.reviewCount} / ~{arrival.expected}</p>
        </div>
        <div className="h-1.5 w-full rounded-full bg-surface-overlay overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={arrival.expected} aria-valuenow={Math.min(arrival.reviewCount, arrival.expected)} aria-label="Reviews in versus expected">
          <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct(arrival)}%` }} />
        </div>
        <p className="text-xs text-fg-muted leading-snug">{text}</p>
        <Outlets a={arrival} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 border-l-2 border-score-tepid pl-3" data-testid="review-arrival" data-phase={arrival.phase}>
      <p className="text-xs text-gray-300 leading-snug">{text}</p>
      <Outlets a={arrival} />
    </div>
  );
}
