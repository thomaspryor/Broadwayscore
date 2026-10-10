import Link from 'next/link';
import { ScoreBadge } from '@/components/show-cards/ScoreBadge';
import { AUTHOR } from '@/config/author';
import type { BlogReview } from '@/lib/data-reviews-blog';

export default function ReviewCard({ review }: { review: BlogReview }) {
  const formattedDate = new Date(review.publishDate + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  // Not wrapped in a single outer <Link> — the byline needs its own real <a>
  // pointing at /about (E-E-A-T entity consolidation), and nested <a> tags are
  // invalid HTML. The title link uses the after:absolute stretched-link
  // pattern to keep the whole card clickable; the byline link sits above it
  // via z-10 so it stays independently clickable. The focus-visible ring is
  // applied to that same ::after pseudo-element (which spans the full card)
  // so keyboard users still see a card-sized focus indicator, not just an
  // outline around the title text.
  return (
    <div className="card card-interactive relative p-5 sm:p-6 group">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-base sm:text-lg font-bold text-white group-hover:text-brand transition-colors line-clamp-2">
            <Link
              href={`/reviews/${review.slug}`}
              className="static after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-brand focus-visible:after:ring-offset-2 focus-visible:after:ring-offset-surface"
            >
              {review.title}
            </Link>
          </h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-sm text-gray-400">
            <span className="font-medium text-gray-300">{review.show}</span>
            <span className="text-gray-500">at {review.venue}</span>
          </div>
          <p className="mt-1.5 text-xs text-gray-500">
            By{' '}
            <Link href={AUTHOR.url} className="relative z-10 text-gray-400 hover:text-brand transition-colors underline-offset-2 hover:underline">
              {AUTHOR.name}
            </Link>
          </p>
          <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-500">
            <time dateTime={review.publishDate}>{formattedDate}</time>
            <span>{review.readingTime} min read</span>
          </div>
          <p className="mt-3 text-sm text-gray-400 line-clamp-2 leading-relaxed">
            {review.excerpt}
          </p>
        </div>
        <div className="flex-shrink-0 pt-1">
          <ScoreBadge score={review.score} size="md" />
        </div>
      </div>
    </div>
  );
}
