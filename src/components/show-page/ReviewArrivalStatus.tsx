import { arrivalText, type ReviewArrival } from '@/lib/review-arrival';

/** Three progress treatments for the one-line opening-night status (BRO-7376). Owner picks one; the rest get deleted. */
export type ReviewArrivalVariant = 'bar' | 'ring' | 'text';

function fraction(a: ReviewArrival): number {
  return Math.max(0, Math.min(1, a.reviewCount / a.expected));
}

function Ring({ f }: { f: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" className="flex-shrink-0 -rotate-90" aria-hidden="true">
      <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" className="stroke-white/15" />
      {f > 0 && (
        <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" strokeLinecap="round" className="stroke-gray-300"
          strokeDasharray={`${c * f} ${c}`} />
      )}
    </svg>
  );
}

/**
 * The status as one short line that sits with the Critic Score where the review
 * count already reads. Rendered inside the hero's score block, never as its own section.
 */
export default function ReviewArrivalLine({ arrival, variant = 'bar', className = '' }: { arrival: ReviewArrival; variant?: ReviewArrivalVariant; className?: string }) {
  const f = fraction(arrival);
  const text = arrivalText(arrival);
  return (
    <span className={`flex flex-col gap-1.5 ${className}`} data-testid="review-arrival" data-phase={arrival.phase}>
      <span className="flex items-start gap-1.5 leading-snug">
        {variant === 'ring' && <span className="mt-0.5"><Ring f={f} /></span>}
        <span>{text}</span>
      </span>
      {variant === 'bar' && (
        <span
          className="block h-1 w-28 rounded-full bg-white/15 overflow-hidden"
          role="progressbar" aria-valuemin={0} aria-valuemax={arrival.expected}
          aria-valuenow={Math.min(arrival.reviewCount, arrival.expected)} aria-label="Reviews in versus expected"
        >
          <span className="block h-full rounded-full bg-gray-300" style={{ width: `${Math.round(f * 100)}%` }} />
        </span>
      )}
    </span>
  );
}
