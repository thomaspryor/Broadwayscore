import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { getCriticBySlug, getAllCriticSlugs } from '@/lib/data-reviews';
import { generateBreadcrumbSchema, generateCriticSchema, generateCriticFAQSchema, BASE_URL } from '@/lib/seo';
import CriticDetailClient from './CriticDetailClient';

export function generateStaticParams() {
  return getAllCriticSlugs().map((slug) => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const critic = getCriticBySlug(params.slug);
  if (!critic) return { title: 'Critic Not Found' };

  const canonicalUrl = `${BASE_URL}/critics/${params.slug}`;
  const description = `${critic.name} (${critic.primaryOutlet}) has reviewed ${critic.reviewCount} Broadway shows with an average score of ${critic.avgScore}/100. See their full review history and rankings.`;

  return {
    title: `${critic.name} - Broadway Critic at ${critic.primaryOutlet} | Broadway Scorecard`,
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title: `${critic.name} - Broadway Critic`,
      description,
      url: canonicalUrl,
      type: 'profile',
      images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
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
    avgScore: critic.avgScore,
    outlets: critic.outlets,
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
