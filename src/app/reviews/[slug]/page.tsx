import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getAllBlogReviews, getBlogReviewBySlug } from '@/lib/data-reviews-blog';
import { ScoreBadge, getScoreTier } from '@/components/show-cards/ScoreBadge';
import Breadcrumb from '@/components/Breadcrumb';
import ReviewBody from '@/components/reviews/ReviewBody';
import StressTest from '@/components/reviews/StressTest';
import AuthorCard from '@/components/reviews/AuthorCard';
import { AUTHOR } from '@/config/author';
import { BASE_URL, toAbsoluteUrl, generateBreadcrumbSchema } from '@/lib/seo';
import { getDataStats } from '@/lib/data-core';

export const revalidate = 3600;

export async function generateStaticParams() {
  try {
    const reviews = await getAllBlogReviews();
    return reviews.map(r => ({ slug: r.slug }));
  } catch (err) {
    console.error('[blog] generateStaticParams failed:', err);
    return [];
  }
}

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const review = await getBlogReviewBySlug(params.slug);
  if (!review) return { title: 'Review Not Found' };

  const description = review.excerpt.slice(0, 160);
  const url = `${BASE_URL}/reviews/${review.slug}`;
  const ogImageUrl = review.heroImage
    ? toAbsoluteUrl(review.heroImage)
    : `${BASE_URL}/og/reviews/${review.slug}.png`;

  return {
    title: `${review.title} | Reviews`,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: review.title,
      description,
      url,
      type: 'article',
      publishedTime: review.publishDate,
      authors: [AUTHOR.name],
      images: [{ url: ogImageUrl, width: 1200, height: 630, alt: review.title }],
    },
    twitter: {
      card: 'summary_large_image',
      title: review.title,
      description,
      images: [{ url: ogImageUrl, width: 1200, height: 630, alt: review.title }],
    },
  };
}

export default async function ReviewPage({ params }: { params: { slug: string } }) {
  const review = await getBlogReviewBySlug(params.slug);
  if (!review) notFound();
  const { totalOutlets } = getDataStats();

  const tier = getScoreTier(review.score);
  const formattedDate = new Date(review.publishDate + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const attendedDate = new Date(review.dateAttended + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  // JSON-LD Review structured data
  const reviewSchema = {
    '@context': 'https://schema.org',
    '@type': 'Review',
    headline: review.title,
    author: {
      '@type': 'Person',
      name: AUTHOR.name,
    },
    publisher: {
      '@type': 'Organization',
      name: 'Broadway Scorecard',
      url: BASE_URL,
    },
    datePublished: review.publishDate,
    reviewBody: review.excerpt,
    itemReviewed: {
      '@type': 'TheaterEvent',
      name: review.show,
      location: {
        '@type': 'PerformingArtsTheater',
        name: review.venue,
        address: {
          '@type': 'PostalAddress',
          addressLocality: 'New York',
          addressRegion: 'NY',
          addressCountry: 'US',
        },
      },
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    },
    reviewRating: {
      '@type': 'Rating',
      ratingValue: review.score,
      bestRating: 100,
      worstRating: 0,
    },
  };

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Reviews', url: `${BASE_URL}/reviews` },
    { name: review.show, url: `${BASE_URL}/reviews/${review.slug}` },
  ]);

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([reviewSchema, breadcrumbSchema]) }}
      />

      <Breadcrumb items={[
        { label: 'Home', href: '/' },
        { label: 'Reviews', href: '/reviews' },
        { label: review.show },
      ]} />

      {/* Header */}
      <header className="mb-10">
        <div className="flex items-start gap-4 sm:gap-5">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-white tracking-tight leading-tight">
              {review.title}
            </h1>
            <p className="mt-3 text-sm text-gray-400">
              By <span className="text-gray-200 font-medium">{AUTHOR.name}</span>
            </p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-sm text-gray-400">
              <span className="font-medium text-gray-200">{review.show}</span>
              <span className="text-gray-500">at {review.venue}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-sm text-gray-500">
              <time dateTime={review.publishDate}>{formattedDate}</time>
              <span>{review.readingTime} min read</span>
            </div>
            {review.dateAttended !== review.publishDate && (
              <p className="mt-1 text-xs text-gray-500">
                Attended {attendedDate}
              </p>
            )}
          </div>
          <div className="flex-shrink-0 pt-1">
            <ScoreBadge score={review.score} size="lg" />
          </div>
        </div>
        {tier && (
          <p className="mt-3 text-sm font-medium" style={{ color: tier.color }}>
            {tier.label}
          </p>
        )}
      </header>

      {/* Review Body */}
      <article className="mb-10">
        <ReviewBody html={review.contentHtml} />
      </article>

      {/* Stress Test */}
      {review.stressTestHtml && (
        <div className="mb-10">
          <StressTest html={review.stressTestHtml} />
        </div>
      )}

      {/* Cross-link to show page */}
      {review.showSlug && (
        <div className="mb-8">
          <Link
            href={`/show/${review.showSlug}`}
            className="inline-flex items-center gap-2 text-sm font-medium text-brand hover:text-brand-light transition-colors"
          >
            See all critic scores for {review.show} &rarr;
          </Link>
        </div>
      )}

      {/* Author */}
      <div className="mb-8">
        <AuthorCard />
      </div>

      {/* Disclaimer */}
      <div className="border-t border-white/5 pt-6">
        <p className="text-xs text-gray-500">
          Broadway Scorecard aggregates critic scores from {totalOutlets}+ outlets. These personal reviews are separate from those scores.
        </p>
      </div>
    </div>
  );
}
