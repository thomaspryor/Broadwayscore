'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Modal, ModalCloseButton } from '@/components/show-cards';
import MiniStars from '@/components/user/Stars';
import type { ShowLookup } from '@/types/user';
import type { FeedPhoto } from '@/lib/review-photos';
import { longDate, showHref, titleFor, type FeedSlide } from './feed-model';

interface PhotoLightboxProps {
  slides: FeedSlide[];
  index: number | null;
  showMap: Record<string, ShowLookup>;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Deletes the photo (row + file). Must throw on failure; the lightbox shows the error. */
  onDelete?: (photo: FeedPhoto) => Promise<void>;
}

/**
 * Full-size photo with the entry it belongs to; arrows (and ←/→) step through
 * `slides`. "Delete photo" asks for an in-page confirm (never window.confirm).
 */
export default function PhotoLightbox({ slides, index, showMap, onIndexChange, onClose, onDelete }: PhotoLightboxProps) {
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
      {/* Portalled outside the Feed, so it needs its own replay block. */}
      <div className="ph-no-capture relative bg-black">
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
          {/* flex + inner truncate: the site's mobile tap-target rule stretches
              links to 44px, which left the title top-aligned above the stars. */}
          <Link href={showHref(show, review.show_id)} className="min-w-0 flex items-center font-bold text-white text-base leading-snug hover:text-brand transition-colors">
            <span className="truncate">{title}</span>
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
        {onDelete && <DeletePhotoControl key={photo.id} photo={photo} onDelete={onDelete} />}
      </div>
    </Modal>
  );
}

/** "Delete photo" → inline confirm → deleting → (error + retry). Keyed per photo so state resets on step. */
function DeletePhotoControl({ photo, onDelete }: { photo: FeedPhoto; onDelete: (photo: FeedPhoto) => Promise<void> }) {
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'deleting'>('idle');
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setPhase('deleting');
    setError(null);
    try {
      await onDelete(photo);
      // The parent drops this slide; nothing left to reset here.
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Couldn’t delete this photo. Try again.');
      setPhase('confirm');
    }
  };

  if (phase === 'idle') {
    return (
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={() => setPhase('confirm')}
          className="inline-flex items-center gap-1.5 min-h-[32px] px-2 -mr-2 rounded-lg text-xs font-medium text-gray-400 hover:text-score-skip transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
          </svg>
          Delete photo
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 p-3 rounded-lg bg-score-skip-bg border border-score-skip/30" role="group" aria-label="Confirm delete">
      <p className="text-sm text-white">Delete this photo?</p>
      <p className="mt-0.5 text-xs text-gray-400">It’s removed from your diary here and in the iPhone app.</p>
      {error && <p role="alert" className="mt-1.5 text-xs text-score-skip">{error}</p>}
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={run}
          disabled={phase === 'deleting'}
          className="btn bg-score-skip-bg text-score-skip border border-score-skip/30 hover:bg-score-skip/20 hover:border-score-skip/50 text-sm disabled:opacity-60"
        >
          {phase === 'deleting' ? 'Deleting…' : error ? 'Retry delete' : 'Delete'}
        </button>
        <button
          type="button"
          onClick={() => { setPhase('idle'); setError(null); }}
          disabled={phase === 'deleting'}
          className="px-4 py-2 text-sm font-medium text-gray-400 hover:text-white transition-colors disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
