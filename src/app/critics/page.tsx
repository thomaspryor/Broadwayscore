import { Metadata } from 'next';
import { getAllCritics } from '@/lib/data-reviews';
import { generateBreadcrumbSchema, generateCriticItemListSchema, BASE_URL } from '@/lib/seo';
import CriticIndexClient from './CriticIndexClient';

export function generateMetadata(): Metadata {
  const allCritics = getAllCritics();
  const totalReviews = allCritics.reduce((sum, c) => sum + c.reviewCount, 0);

  const title = `${allCritics.length} Theatre Critics & Reviewers`;
  const description = `Browse ${allCritics.length} theatre critics covering Broadway and the West End, with ${totalReviews.toLocaleString()} reviews. See average scores, review counts, and full review histories for every critic.`;

  return {
    title,
    description,
    alternates: { canonical: `${BASE_URL}/critics` },
    openGraph: {
      title: 'Theatre Critics & Reviewers',
      description,
      url: `${BASE_URL}/critics`,
      type: 'website',
      images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary',
      title: 'Theatre Critics & Reviewers',
      description,
    },
  };
}

export default function CriticIndexPage() {
  const allCritics = getAllCritics();
  const totalReviews = allCritics.reduce((sum, c) => sum + c.reviewCount, 0);

  // Strip reviews array for the index page (just need metadata for cards)
  const criticSummaries = allCritics.map(({ reviews, ...rest }) => rest);

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Critics', url: `${BASE_URL}/critics` },
  ]);

  const itemListSchema = generateCriticItemListSchema(allCritics.map(c => ({
    name: c.name,
    slug: c.slug,
    primaryOutlet: c.primaryOutlet,
    reviewCount: c.reviewCount,
    avgScore: c.avgScore,
  })));

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, itemListSchema]) }}
      />
      <CriticIndexClient critics={criticSummaries} totalReviews={totalReviews} />
    </>
  );
}
