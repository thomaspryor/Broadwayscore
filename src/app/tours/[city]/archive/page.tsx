import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { isCategoryEnabled } from '@/lib/markets';
import { HUB_CITIES } from '@/lib/city-hub';
import { getCityHubShows } from '@/lib/data-city-hub';
import { formatShowDate } from '@/lib/date-utils';
import { BASE_URL } from '@/lib/seo';
import Breadcrumb from '@/components/Breadcrumb';

// Older productions behind a city hub (BRO-6517). A plain list, not cards, so
// a metro with ~1,000 local productions stays a light page. Not indexed.

export const revalidate = 86400;
export const dynamicParams = false;

export function generateStaticParams() {
  if (!isCategoryEnabled('tour')) return [];
  return Object.keys(HUB_CITIES).map(city => ({ city }));
}

export async function generateMetadata(props: { params: Promise<{ city: string }> }): Promise<Metadata> {
  const { city } = await props.params;
  const hub = HUB_CITIES[city];
  if (!hub) return { title: 'Page Not Found' };
  return {
    title: `${hub.short} Theater Archive: Older Productions & Critic Scores`,
    alternates: { canonical: `${BASE_URL}/tours/${city}/archive` },
    robots: { index: false, follow: true },
  };
}

export default async function CityArchivePage(props: { params: Promise<{ city: string }> }) {
  const { city } = await props.params;
  const hub = HUB_CITIES[city];
  if (!isCategoryEnabled('tour') || !hub) notFound();
  const today = new Date().toISOString().slice(0, 10);
  const { archive } = getCityHubShows(city, today);
  const year = { year: 'numeric' } as const;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
      <Breadcrumb items={[
        { label: 'Home', href: '/' },
        { label: `${hub.short} Theater`, href: `/tours/${city}` },
        { label: 'Archive' },
      ]} />
      <h1 className="text-3xl font-bold text-white mb-1">{hub.short} Theater Archive</h1>
      <p className="text-gray-400 mb-6">{archive.length} older productions, newest first.</p>
      <ul className="divide-y divide-white/10">
        {archive.map(s => (
          <li key={s.id} className="py-3 flex items-baseline justify-between gap-4">
            <div className="min-w-0">
              <Link href={`/show/${s.slug}`} className="text-white hover:text-brand font-medium">{s.title}</Link>
              <p className="text-xs text-fg-muted truncate">
                {s.venue?.replace(/,\s*Chicago,\s*IL$/, '')}
                {s.closingDate || s.openingDate ? ` · ${formatShowDate((s.closingDate || s.openingDate)!, year)}` : ''}
              </p>
            </div>
            {s.criticScore?.score != null && (
              <span className="text-sm tabular-nums text-gray-300">{Math.round(s.criticScore.score)}</span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-sm text-gray-400 mt-8">
        <Link href={`/tours/${city}`} className="text-brand hover:text-brand-hover font-medium">← {hub.short} Theater</Link>
      </p>
    </div>
  );
}
