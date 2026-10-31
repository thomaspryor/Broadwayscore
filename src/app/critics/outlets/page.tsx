import { Metadata } from 'next';
import { getAllOutlets } from '@/lib/data-reviews';
import { generateBreadcrumbSchema, generateOutletItemListSchema, BASE_URL } from '@/lib/seo';
import OutletIndexClient from './OutletIndexClient';

export function generateMetadata(): Metadata {
  const allOutlets = getAllOutlets();
  const totalReviews = allOutlets.reduce((sum, o) => sum + o.reviewCount, 0);
  const tier1Count = allOutlets.filter(o => o.tier === 1).length;

  const title = `${allOutlets.length} Broadway Review Outlets & Publications`;
  const description = `Browse ${allOutlets.length} publications reviewing Broadway shows, including ${tier1Count} Tier 1 outlets. ${totalReviews.toLocaleString()} total reviews with average scores and tier rankings.`;

  return {
    title,
    description,
    alternates: { canonical: `${BASE_URL}/critics/outlets` },
    openGraph: {
      title: 'Broadway Review Outlets & Publications',
      description,
      url: `${BASE_URL}/critics/outlets`,
      type: 'website',
      images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary',
      title: 'Broadway Review Outlets & Publications',
      description,
    },
  };
}

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

  const itemListSchema = generateOutletItemListSchema(allOutlets.map(o => ({
    name: o.name,
    slug: o.slug,
    reviewCount: o.reviewCount,
    tier: o.tier,
  })));

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, itemListSchema]) }}
      />
      <OutletIndexClient outlets={outletSummaries} totalReviews={totalReviews} />
    </>
  );
}
