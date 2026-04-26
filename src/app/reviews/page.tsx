import { Metadata } from 'next';
import { getAllBlogReviews } from '@/lib/data-reviews-blog';
import { getDataStats } from '@/lib/data-core';
import ReviewCard from '@/components/reviews/ReviewCard';
import Breadcrumb from '@/components/Breadcrumb';
import { BASE_URL } from '@/lib/seo';

const ogImageUrl = `${BASE_URL}/og/home.png`;

export const metadata: Metadata = {
  title: 'Reviews',
  description: 'Personal Broadway reviews from the founder of Broadway Scorecard. Honest takes on what\'s worth seeing — and what isn\'t.',
  alternates: {
    canonical: `${BASE_URL}/reviews`,
  },
  openGraph: {
    title: 'Reviews | Broadway Scorecard',
    description: 'Personal Broadway reviews from the founder of Broadway Scorecard.',
    url: `${BASE_URL}/reviews`,
    type: 'website',
    images: [{ url: ogImageUrl, width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Reviews | Broadway Scorecard',
    description: 'Personal Broadway reviews from the founder of Broadway Scorecard.',
    images: [{ url: ogImageUrl, width: 1200, height: 630 }],
  },
};

export const revalidate = 60;

export default async function ReviewsPage() {
  const reviews = await getAllBlogReviews();
  const { totalOutlets } = getDataStats();

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <Breadcrumb items={[
        { label: 'Home', href: '/' },
        { label: 'Reviews' },
      ]} />

      <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight mb-2">
        Reviews
      </h1>
      <p className="text-gray-400 mb-8 max-w-xl">
        Personal reviews from the founder of Broadway Scorecard. Honest takes on what&apos;s worth seeing — and what isn&apos;t.
      </p>

      {/* Disclaimer */}
      <div className="card p-4 mb-8 border-l-4 border-brand/20">
        <p className="text-sm text-gray-400">
          Broadway Scorecard aggregates critic scores from {totalOutlets}+ outlets. These personal reviews are separate from those scores.
        </p>
      </div>

      {reviews.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-gray-400">No reviews yet. Check back soon.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {reviews.map(review => (
            <ReviewCard key={review.slug} review={review} />
          ))}
        </div>
      )}
    </div>
  );
}
