import type { ScoredReview } from '@/lib/engine';
import { formatDate } from '@/lib/format';
import { OutletMark, OutletTierChip, ScoreBadge } from './product-cards';

export function ReviewRow({ review }: { review: ScoredReview }) {
  return (
    <article className="flex gap-3 border-b border-line py-4 last:border-b-0 sm:gap-4">
      <ScoreBadge score={review.score} size="review" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <OutletMark name={review.outlet.name} />
          <span className="font-bold">{review.outlet.name}</span>
          <OutletTierChip tier={review.outlet.tier} />
          {review.editorsChoice && (
            <span className="rounded bg-amber-100 px-1.5 py-[1px] text-[11px] font-semibold text-amber-800">★ Editors&apos; Choice</span>
          )}
          <span className="ml-auto text-xs text-ink-faint">{formatDate(review.date)}</span>
        </div>
        <p className="mt-2 leading-relaxed text-ink">&ldquo;{review.excerpt}&rdquo;</p>
        {review.note && <p className="mt-1 text-xs italic text-ink-faint">{review.note}</p>}
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-ink-faint">
            {review.critic ? `By ${review.critic}` : 'Staff review'}
            {' · '}
            {review.rating ? <span className="font-medium text-ink-muted">Rated {review.rating}</span> : <span title="This outlet does not publish a score; we scored the review's verdict from its text.">Unrated, scored from text</span>}
          </span>
          <a href={review.url} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-brand-ink hover:underline">
            Full review <span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
    </article>
  );
}

const VISIBLE = 6;

export function ReviewList({ reviews }: { reviews: ScoredReview[] }) {
  const head = reviews.slice(0, VISIBLE);
  const rest = reviews.slice(VISIBLE);
  return (
    <div>
      {head.map((r) => <ReviewRow key={`${r.outletId}|${r.url}`} review={r} />)}
      {rest.length > 0 && (
        <details className="more">
          <summary className="mt-2 cursor-pointer rounded-xl border border-line bg-surface-overlay py-3 text-center text-sm font-semibold text-brand-ink hover:border-line-strong">
            <span className="more-closed">Show {rest.length} more reviews ▾</span>
            <span className="more-open">Show fewer ▴</span>
          </summary>
          {rest.map((r) => <ReviewRow key={`${r.outletId}|${r.url}`} review={r} />)}
        </details>
      )}
    </div>
  );
}
