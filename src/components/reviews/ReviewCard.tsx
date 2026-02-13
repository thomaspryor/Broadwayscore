import Link from 'next/link';
import { ScoreBadge } from '@/components/show-cards/ScoreBadge';
import type { BlogReview } from '@/lib/data-reviews-blog';

export default function ReviewCard({ review }: { review: BlogReview }) {
  const formattedDate = new Date(review.publishDate + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <Link href={`/reviews/${review.slug}`} className="card card-interactive block p-5 sm:p-6 group">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-base sm:text-lg font-bold text-white group-hover:text-brand transition-colors line-clamp-2">
            {review.title}
          </h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-sm text-gray-400">
            <span className="font-medium text-gray-300">{review.show}</span>
            <span className="text-gray-500">at {review.venue}</span>
          </div>
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
    </Link>
  );
}
