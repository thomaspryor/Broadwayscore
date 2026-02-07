import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { getCriticBySlug, getAllCriticSlugs } from '@/lib/data-reviews';
import { generateBreadcrumbSchema, generateCriticSchema } from '@/lib/seo';
import CriticDetailClient from './CriticDetailClient';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export function generateStaticParams() {
  return getAllCriticSlugs().map((slug) => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const critic = getCriticBySlug(params.slug);
  if (!critic) return { title: 'Critic Not Found' };

  const canonicalUrl = `${BASE_URL}/critics/${params.slug}`;
  const description = `${critic.name} (${critic.primaryOutlet}) has reviewed ${critic.reviewCount} Broadway shows with an average score of ${critic.avgScore}/100.`;

  return {
    title: `${critic.name} - Broadway Critic at ${critic.primaryOutlet} | Broadway Scorecard`,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title: `${critic.name} - Broadway Critic`,
      description,
      url: canonicalUrl,
      type: 'profile',
    },
    twitter: {
      card: 'summary',
      title: `${critic.name} - Broadway Critic`,
      description,
    },
  };
}

export default function CriticDetailPage({ params }: { params: { slug: string } }) {
  const critic = getCriticBySlug(params.slug);
  if (!critic) notFound();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Critics', url: `${BASE_URL}/critics` },
    { name: critic.name, url: `${BASE_URL}/critics/${params.slug}` },
  ]);

  const criticSchema = generateCriticSchema({
    name: critic.name,
    slug: critic.slug,
    primaryOutlet: critic.primaryOutlet,
    reviewCount: critic.reviewCount,
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, criticSchema]) }}
      />
      <CriticDetailClient critic={critic} />
    </>
  );
}
