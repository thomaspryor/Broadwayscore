import { notFound } from 'next/navigation';
import { Metadata } from 'next';
import { getOperaShows, getOperaShowByTitleSlug, getOperaTitleSlug } from '@/lib/data-core';
import { BASE_URL } from '@/lib/seo';
import ShowPage, { generateMetadata as showGenerateMetadata } from '@/app/show/[slug]/page';

export const revalidate = 86400;

export function generateStaticParams() {
  return getOperaShows().map(s => ({ slug: getOperaTitleSlug(s.slug) }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const show = getOperaShowByTitleSlug(params.slug);
  if (!show) return { title: 'Show Not Found' };
  const base = showGenerateMetadata({ params: { slug: show.slug } });
  return {
    ...base,
    alternates: { canonical: `${BASE_URL}/opera/${params.slug}` },
  };
}

export default async function OperaShowPage({ params }: { params: { slug: string } }) {
  const show = getOperaShowByTitleSlug(params.slug);
  if (!show) throw notFound();
  return ShowPage({ params: { slug: show.slug } });
}
