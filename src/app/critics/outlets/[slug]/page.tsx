import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { getOutletBySlug, getAllOutletSlugs } from '@/lib/data-reviews';
import { generateBreadcrumbSchema, generateOutletSchema } from '@/lib/seo';
import OutletDetailClient from './OutletDetailClient';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export function generateStaticParams() {
  return getAllOutletSlugs().map((slug) => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const outlet = getOutletBySlug(params.slug);
  if (!outlet) return { title: 'Outlet Not Found' };

  const canonicalUrl = `${BASE_URL}/critics/outlets/${params.slug}`;
  const description = `${outlet.name} has published ${outlet.reviewCount} Broadway reviews with an average critic score of ${outlet.avgScore}/100. See their full review history.`;

  return {
    title: `${outlet.name} - Broadway Reviews | Broadway Scorecard`,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title: `${outlet.name} - Broadway Reviews`,
      description,
      url: canonicalUrl,
      type: 'website',
    },
    twitter: {
      card: 'summary',
      title: `${outlet.name} - Broadway Reviews`,
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
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, outletSchema]) }}
      />
      <OutletDetailClient outlet={outlet} />
    </>
  );
}
