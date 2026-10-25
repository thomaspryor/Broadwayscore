import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { getCriticBySlug } from '@/lib/data-reviews';
import { generateBreadcrumbSchema, generateCriticSchema, generateCriticFAQSchema, BASE_URL } from '@/lib/seo';
import { criticMarketLabel, showCountPhrase } from '@/lib/critic-market';
import { isThinCriticPage } from '@/lib/seo-indexability';
import CriticDetailClient from './CriticDetailClient';

export const revalidate = 43200;
export const dynamicParams = true;

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const params = await props.params;
  const critic = getCriticBySlug(params.slug);
  if (!critic) return { title: 'Critic Not Found' };

  const canonicalUrl = `${BASE_URL}/critics/${params.slug}`;
  const market = criticMarketLabel(critic.reviews);
  const description = `${critic.name} (${critic.primaryOutlet}) has reviewed ${showCountPhrase(critic.reviewCount, market)} with an average score of ${critic.avgScore}/100. See their full review history and rankings.`;

  return {
    title: `${critic.name} - ${market} Critic at ${critic.primaryOutlet}`,
    description,
    ...(isThinCriticPage(critic, params.slug) ? { robots: { index: false, follow: true } } : {}),
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title: `${critic.name} - ${market} Critic`,
      description,
      url: canonicalUrl,
      type: 'profile',
      images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary',
      title: `${critic.name} - ${market} Critic`,
      description,
    },
  };
}

export default async function CriticDetailPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
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
    avgScore: critic.avgScore,
    outlets: critic.outlets,
    marketLabel: criticMarketLabel(critic.reviews),
  });

  const faqSchema = generateCriticFAQSchema({
    name: critic.name,
    primaryOutlet: critic.primaryOutlet,
    outlets: critic.outlets,
    reviewCount: critic.reviewCount,
    avgScore: critic.avgScore,
    highScore: critic.highScore,
    lowScore: critic.lowScore,
    isFreelancer: critic.isFreelancer,
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, criticSchema, faqSchema]) }}
      />
      <CriticDetailClient critic={critic} />
    </>
  );
}
