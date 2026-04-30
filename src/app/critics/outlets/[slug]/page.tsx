import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { getOutletBySlug, getAllOutletSlugs } from '@/lib/data-reviews';
import { generateBreadcrumbSchema, generateOutletSchema, generateOutletFAQSchema, BASE_URL } from '@/lib/seo';
import OutletDetailClient from './OutletDetailClient';

export const revalidate = 43200;

export function generateStaticParams() {
  return getAllOutletSlugs().map(slug => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const outlet = getOutletBySlug(params.slug);
  if (!outlet) return { title: 'Outlet Not Found' };

  const canonicalUrl = `${BASE_URL}/critics/outlets/${params.slug}`;
  const tierLabel = outlet.tier === 1 ? 'Tier 1'
    : outlet.tier === 2 ? 'Tier 2'
    : outlet.tier === 4 ? 'Tier 4'
    : 'Tier 3';
  const description = `${outlet.name} (${tierLabel}) has published ${outlet.reviewCount} theatre reviews with an average score of ${outlet.avgScore}/100. ${outlet.criticCount} critics, full review history covering Broadway and the West End.`;

  return {
    title: `${outlet.name} - Theatre Reviews (${tierLabel})`,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title: `${outlet.name} - Theatre Reviews`,
      description,
      url: canonicalUrl,
      type: 'website',
      images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary',
      title: `${outlet.name} - Theatre Reviews`,
      description,
    },
  };
}

export default function OutletDetailPage({ params }: { params: { slug: string } }) {
  const outlet = getOutletBySlug(params.slug);
  if (!outlet) notFound();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Critics', url: `${BASE_URL}/critics` },
    { name: 'Outlets', url: `${BASE_URL}/critics/outlets` },
    { name: outlet.name, url: `${BASE_URL}/critics/outlets/${params.slug}` },
  ]);

  const outletSchema = generateOutletSchema({
    name: outlet.name,
    slug: outlet.slug,
    reviewCount: outlet.reviewCount,
    avgScore: outlet.avgScore,
    tier: outlet.tier,
    logoDomain: outlet.logoDomain,
    criticCount: outlet.criticCount,
  });

  const faqSchema = generateOutletFAQSchema({
    name: outlet.name,
    tier: outlet.tier,
    reviewCount: outlet.reviewCount,
    avgScore: outlet.avgScore,
    criticCount: outlet.criticCount,
    highScore: outlet.highScore,
    lowScore: outlet.lowScore,
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, outletSchema, faqSchema]) }}
      />
      <OutletDetailClient outlet={outlet} />
    </>
  );
}
