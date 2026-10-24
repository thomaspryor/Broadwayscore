'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Modal, ModalCloseButton } from '@/components/show-cards';
import MiniStars from '@/components/user/Stars';
import type { ShowLookup } from '@/types/user';
import { longDate, showHref, titleFor, type FeedSlide } from './feed-model';

interface PhotoLightboxProps {
  slides: FeedSlide[];
  index: number | null;
  showMap: Record<string, ShowLookup>;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

/** Full-size photo with the entry it belongs to; arrows (and ←/→) step through `slides`. */
export default function PhotoLightbox({ slides, index, showMap, onIndexChange, onClose }: PhotoLightboxProps) {
  const open = index !== null && index >= 0 && index < slides.length;
  const count = slides.length;

  useEffect(() => {
    if (!open || count < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') onIndexChange(((index as number) + 1) % count);
      if (e.key === 'ArrowLeft') onIndexChange(((index as number) - 1 + count) % count);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, index, count, onIndexChange]);

  if (!open) return null;
  const { photo, review } = slides[index];
  const show = showMap[review.show_id];
  const title = titleFor(show, review.show_id);
  const date = longDate(review.date_seen);
  const step = (delta: number) => onIndexChange((index + delta + count) % count);

  return (
    <Modal isOpen onClose={onClose} maxWidth="xl" ariaLabel={`Photo from ${title}`}>
      <div className="relative bg-black">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={photo.id}
          src={photo.url}
          alt={`Photo from ${title}${date ? `, ${date}` : ''}`}
          className="block w-full h-auto max-h-[62vh] object-contain"
        />
        <div className="absolute top-2 right-2 flex items-center gap-2">
          {count > 1 && (
            <span className="px-2 py-1 rounded-full bg-black/60 text-xs font-semibold text-white tabular-nums">
              {index + 1} / {count}
            </span>
          )}
          <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-black/60">
            <ModalCloseButton onClick={onClose} className="text-white" />
          </span>
        </div>
        {count > 1 && (
          <>
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label="Previous photo"
              className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              aria-label="Next photo"
              className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
            </button>
          </>
        )}
      </div>
      <div className="px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <Link href={showHref(show, review.show_id)} className="min-w-0 font-bold text-white text-base leading-snug truncate hover:text-brand transition-colors">
            {title}
          </Link>
          {review.rating > 0 && (
            <div className="flex-shrink-0 flex items-center gap-px" role="img" aria-label={`${review.rating} out of 5 stars`}>
              <MiniStars rating={review.rating} />
            </div>
          )}
        </div>
        <p className="mt-0.5 text-xs text-gray-400 truncate">
          {[date, show?.venue].filter(Boolean).join(' \u00b7 ') || 'Date not set'}
        </p>
      </div>
    </Modal>
  );
}
