import { arrivalText, type ReviewArrival } from '@/lib/review-arrival';

/** Round 3 (BRO-7376): text only is the proposal; the thin bar is kept for one comparison picture. */
export type ReviewArrivalVariant = 'text' | 'bar';

function fraction(a: ReviewArrival): number {
  return Math.max(0, Math.min(1, a.reviewCount / a.expected));
}

/**
 * The status as one short line that sits with the Critic Score where the review
 * count already reads. Rendered inside the hero's score block, never as its own section.
 */
export default function ReviewArrivalLine({ arrival, variant = 'text', className = '' }: { arrival: ReviewArrival; variant?: ReviewArrivalVariant; className?: string }) {
  const f = fraction(arrival);
  const text = arrivalText(arrival);
  return (
    <span className={`flex flex-col gap-1.5 ${className}`} data-testid="review-arrival" data-phase={arrival.phase}>
      <span className="flex items-start gap-1.5 leading-snug">
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
