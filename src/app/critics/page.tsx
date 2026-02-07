import { Metadata } from 'next';
import { getAllCritics } from '@/lib/data-reviews';
import { generateBreadcrumbSchema } from '@/lib/seo';
import CriticIndexClient from './CriticIndexClient';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export const metadata: Metadata = {
  title: 'Broadway Critics & Reviewers | Broadway Scorecard',
  description: 'Browse all Broadway critics and reviewers. See review counts, average scores, and full review histories for every critic.',
  alternates: { canonical: `${BASE_URL}/critics` },
};

export default function CriticIndexPage() {
  const allCritics = getAllCritics();
  const totalReviews = allCritics.reduce((sum, c) => sum + c.reviewCount, 0);

  // Strip reviews array for the index page (just need metadata for cards)
  const criticSummaries = allCritics.map(({ reviews, ...rest }) => rest);

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Critics', url: `${BASE_URL}/critics` },
  ]);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />
      <CriticIndexClient critics={criticSummaries} totalReviews={totalReviews} />
    </>
  );
}
