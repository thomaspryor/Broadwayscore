import Link from 'next/link';
import type { ComputedShow } from '@/lib/data-types';
import { getOptimizedImageUrl } from '@/lib/images';
import ShowImage from '@/components/ShowImage';
import { ScoreBadge } from '@/components/show-cards';

export default function RelatedShows({ shows, title = 'You Might Also Like' }: { shows: ComputedShow[]; title?: string }) {
  if (shows.length === 0) return null;

  return (
    <section className="mt-8 pt-6 border-t border-white/5">
      <h2 className="text-base font-bold text-white mb-3">{title}</h2>
      <div className="flex gap-3 overflow-x-auto pb-3 -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-hide">
        {shows.map((show) => (
          <Link
            key={show.id}
            href={`/show/${show.slug}`}
            className="flex-shrink-0 w-28 sm:w-32 group"
          >
            <div className="relative rounded-lg overflow-hidden bg-surface-overlay aspect-[2/3] mb-1.5">
              <ShowImage
                sources={[
                  show.images?.poster ? getOptimizedImageUrl(show.images.poster, 'card') : null,
                  show.images?.thumbnail ? getOptimizedImageUrl(show.images.thumbnail, 'card') : null,
                  show.images?.hero ? getOptimizedImageUrl(show.images.hero, 'card') : null,
                ]}
                alt={`${show.title} Broadway ${show.type}`}
                loading="lazy"
                sizes="(min-width: 640px) 128px, 112px"
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                fallback={
                  <div className="w-full h-full flex items-center justify-center text-gray-500" aria-hidden="true">
                    <div className="text-2xl">🎭</div>
                  </div>
                }
              />
              <div className="absolute bottom-1.5 right-1.5">
                <ScoreBadge score={show.criticScore?.score} size="sm" showCrown />
              </div>
            </div>
            <h3 className="font-semibold text-white text-sm group-hover:text-brand transition-colors line-clamp-2 leading-tight">
              {show.title}
            </h3>
          </Link>
        ))}
      </div>
    </section>
  );
}
