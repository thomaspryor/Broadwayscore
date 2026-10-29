'use client';

import Link from 'next/link';
import MiniStars from '@/components/user/Stars';
import { Poster, SectionBand } from '@/components/user/upcoming-cards';
import type { ShowLookup } from '@/types/user';
import type { FeedPhoto } from '@/lib/review-photos';
import PhotoTile from './PhotoTile';
import PhotoThumbRow, { AddPhotoButton } from './PhotoThumbRow';
import type { PhotoUploads } from './usePhotoUploads';
import { dayMonth, longDate, showHref, titleFor, type FeedEntry, type FeedMonthGroup } from './feed-model';

interface FeedTimelineProps {
  groups: FeedMonthGroup[];
  showMap: Record<string, ShowLookup>;
  onOpenPhoto: (entry: FeedEntry, photoIndex: number) => void;
  uploads: PhotoUploads;
}

/**
 * Timeline: month bands, then one card per night (the app's
 * PhotoFeedTimeline): date block, poster, title, venue, note, stars, and the
 * night's photos below. Each entry under the per-entry limit gets one quiet
 * "Add a photo" / "Add more" button (no nagging); while photos upload they
 * show as tiles with an Add tile beside them.
 */
export default function FeedTimeline({ groups, showMap, onOpenPhoto, uploads }: FeedTimelineProps) {
  return (
    <div>
      {groups.map(group => (
        <section key={group.key} className="mb-6" aria-labelledby={`feed-month-${group.key}`}>
          <SectionBand id={`feed-month-${group.key}`} title={group.label} count={group.entries.length} />
          <div className="space-y-2.5">
            {group.entries.map(entry => (
              <EntryCard
                key={entry.review.id}
                entry={entry}
                show={showMap[entry.review.show_id]}
                onOpenPhoto={i => onOpenPhoto(entry, i)}
                uploads={uploads}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function EntryCard({ entry, show, onOpenPhoto, uploads }: {
  entry: FeedEntry;
  show: ShowLookup | undefined;
  onOpenPhoto: (photoIndex: number) => void;
  uploads: PhotoUploads;
}) {
  const { review, photos } = entry;
  const savedIds = new Set(photos.map(p => p.id));
  const pending = uploads.pendingFor(review.id).filter(p => !savedIds.has(p.id));
  const canAdd = uploads.remainingFor(review.id) > 0;
  const notice = uploads.noticeFor(review.id);
  const addFiles = (files: File[]) => uploads.addFiles(review.id, files);
  const title = titleFor(show, review.show_id);
  const href = showHref(show, review.show_id);
  const block = review.date_seen ? dayMonth(review.date_seen) : null;

  return (
    <article className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-3 sm:p-4">
      <div className="flex items-center gap-2.5 sm:gap-3">
        {block && (
          <div className="flex-shrink-0 w-8 text-center">
            <p aria-hidden="true" className="text-base font-bold leading-tight text-white">{block.day}</p>
            <p aria-hidden="true" className="text-xs font-bold uppercase text-fg-muted">{block.month}</p>
            <span className="sr-only">{longDate(review.date_seen)}</span>
          </div>
        )}
        <Link href={href} tabIndex={-1} aria-hidden="true" className="flex-shrink-0 w-10 h-14 rounded-lg overflow-hidden bg-surface-overlay">
          <Poster url={show?.posterUrl} iconClass="text-lg" />
        </Link>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-white text-base leading-snug truncate">
            <Link href={href} className="hover:text-brand transition-colors">{title}</Link>
          </h3>
          {show?.venue && <p className="text-xs text-fg-muted truncate">{show.venue}</p>}
          {review.rating > 0 && (
            <div className="sm:hidden mt-1 flex items-center gap-px" role="img" aria-label={`${review.rating} out of 5 stars`}>
              <MiniStars rating={review.rating} />
            </div>
          )}
          {review.review_text && (
            <p className="mt-1 text-sm text-gray-300 leading-snug line-clamp-2 break-words">{review.review_text}</p>
          )}
        </div>
        {review.rating > 0 && (
          <div className="hidden sm:flex flex-shrink-0 self-start mt-1 items-center gap-px" role="img" aria-label={`${review.rating} out of 5 stars`}>
            <MiniStars rating={review.rating} />
          </div>
        )}
      </div>

      {photos.length > 0 && <PhotoCollage photos={photos} title={title} onOpen={onOpenPhoto} />}

      {pending.length > 0 ? (
        <div className="mt-2">
          <PhotoThumbRow
            pending={pending}
            canAdd={canAdd}
            onAddFiles={addFiles}
            onRetry={uploads.retry}
            onDismiss={uploads.dismiss}
            notice={notice}
            title={title}
            size="sm"
          />
        </div>
      ) : (
        <>
          {canAdd && (
            <div className="mt-1.5 flex justify-end">
              <AddPhotoButton title={title} onAddFiles={addFiles} label={photos.length > 0 ? 'Add more' : 'Add a photo'} />
            </div>
          )}
          {notice && <p className="text-xs text-gray-400 text-right">{notice}</p>}
        </>
      )}
    </article>
  );
}

/**
 * 1 photo: one wide frame. 2: side by side. 3+: a large lead photo with two
 * stacked beside it, "+N" on the last when there are more. Height is capped
 * by the aspect box (~300px tall in the 3xl column), never a full-bleed image.
 */
function PhotoCollage({ photos, title, onOpen }: { photos: FeedPhoto[]; title: string; onOpen: (i: number) => void }) {
  const n = photos.length;
  const label = (i: number) => `Open photo ${i + 1} of ${n} from ${title}`;

  if (n === 1) {
    return (
      <div className="mt-3 rounded-lg overflow-hidden">
        <PhotoTile url={photos[0].url} label={label(0)} onOpen={() => onOpen(0)} className="w-full aspect-[3/2] sm:aspect-[16/7]" />
      </div>
    );
  }

  if (n === 2) {
    return (
      <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg overflow-hidden aspect-[2/1] sm:aspect-[16/7]">
        {photos.map((p, i) => (
          <PhotoTile key={p.id} url={p.url} label={label(i)} onOpen={() => onOpen(i)} className="w-full h-full" />
        ))}
      </div>
    );
  }

  const extra = n - 3;
  return (
    <div className="mt-3 grid grid-cols-3 grid-rows-2 gap-1 rounded-lg overflow-hidden aspect-[3/2] sm:aspect-[16/7]">
      <PhotoTile url={photos[0].url} label={label(0)} onOpen={() => onOpen(0)} className="col-span-2 row-span-2 w-full h-full" />
      <PhotoTile url={photos[1].url} label={label(1)} onOpen={() => onOpen(1)} className="w-full h-full" />
      <PhotoTile url={photos[2].url} label={extra > 0 ? `Open all ${n} photos from ${title}` : label(2)} onOpen={() => onOpen(2)} className="w-full h-full">
        {extra > 0 && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-white text-lg font-bold">+{extra}</span>
        )}
      </PhotoTile>
    </div>
  );
}
