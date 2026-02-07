import { Metadata } from 'next';
import { getAllOutlets } from '@/lib/data-reviews';
import { generateBreadcrumbSchema } from '@/lib/seo';
import OutletIndexClient from './OutletIndexClient';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export const metadata: Metadata = {
  title: 'Broadway Review Outlets & Publications | Broadway Scorecard',
  description: 'Browse all publications and outlets that review Broadway shows, organized by tier. See review counts, average scores, and full review histories.',
  alternates: { canonical: `${BASE_URL}/critics/outlets` },
};

export default function OutletIndexPage() {
  const allOutlets = getAllOutlets();
  const totalReviews = allOutlets.reduce((sum, o) => sum + o.reviewCount, 0);

  // Strip reviews array for the index page (just need metadata for cards)
  const outletSummaries = allOutlets.map(({ reviews, ...rest }) => rest);

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Critics', url: `${BASE_URL}/critics` },
    { name: 'Outlets', url: `${BASE_URL}/critics/outlets` },
  ]);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />
      <OutletIndexClient outlets={outletSummaries} totalReviews={totalReviews} />
    </>
  );
}
