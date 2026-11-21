'use client';

import Link from 'next/link';
import { ShowListCard } from '@/components/show-cards';
import type { ShowCardShow } from '@/components/show-cards/types';
import { useLocationSearch } from '@/lib/hooks/useLocationSearch';
import { withBioUtm } from '../../../scripts/lib/links-featured';

interface Props {
  featured: ShowCardShow | null;
  label: string;
  shows: ShowCardShow[];
}

export default function LinksPageClient({ featured, label, shows }: Props) {
  const search = useLocationSearch();
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <header className="text-center mb-8">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-white mb-3">Latest From Our Socials</h1>
        <p className="text-gray-300">
          The shows we just posted about. Tap one for every critic review and its Critic Score.
        </p>
      </header>

      {featured && (
        <section aria-labelledby="featured-video" className="mb-8">
          <h2 id="featured-video" className="text-lg font-bold text-white mb-3">{label}: {featured.title}</h2>
          <ShowListCard show={featured} index={0} priorityFirstImage scoreMode="critics" variant="compact" showReviewCount showCategoryBadge isMixedStatus overrideHref={withBioUtm(`/show/${featured.slug}`, search)} />
        </section>
      )}

      {shows.length > 0 ? (
        <ol className="space-y-3" aria-label="Recent social posts">
          {shows.map((show, i) => (
            <li key={show.id}>
              <ShowListCard show={show} index={i} priorityFirstImage={!featured} scoreMode="critics" variant="compact" showReviewCount showCategoryBadge isMixedStatus overrideHref={withBioUtm(`/show/${show.slug}`, search)} />
            </li>
          ))}
        </ol>
      ) : !featured ? (
        <div className="card p-6 text-center text-gray-300">No posts yet. See what&apos;s scoring now on the homepage.</div>
      ) : null}

      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Link href={withBioUtm('/', search)} className="btn-primary text-center">Broadway shows</Link>
        <Link href={withBioUtm('/west-end', search)} className="btn-secondary text-center">West End shows</Link>
      </div>
    </div>
  );
}
