'use client';

import { useEffect, useRef, useState } from 'react';
import type { FeedPhoto } from '@/lib/review-photos';
import { PHOTO_INPUT_ACCEPT } from '@/lib/review-photo-model';
import { catchEarlyImgError } from '@/lib/img-early-error';
import type { PendingPhoto } from './usePhotoUploads';

/**
 * Hidden multi-file input. `image/*` keeps iOS Safari converting HEIC to
 * JPEG on the way in (see PHOTO_INPUT_ACCEPT). The value is cleared after
 * each pick so choosing the same file again still fires onChange.
 */
export function PhotoFileInput({ inputRef, onFiles }: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  onFiles: (files: File[]) => void;
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept={PHOTO_INPUT_ACCEPT}
      multiple
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      onChange={e => {
        const files = Array.from(e.currentTarget.files ?? []);
        e.currentTarget.value = '';
        if (files.length) onFiles(files);
      }}
    />
  );
}

export function CameraIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
    </svg>
  );
}

function Spinner({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function XIcon({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

/** Image inside a thumb; a preview the browser can't render (HEIC on Chrome) shows the camera glyph. */
function ThumbImage({ src }: { src: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span className="absolute inset-0 flex items-center justify-center text-fg-muted">
        <CameraIcon className="w-5 h-5" />
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className="absolute inset-0 w-full h-full object-cover" ref={catchEarlyImgError(() => setBroken(true))} onError={() => setBroken(true)} />;
}

const SIZE = { md: 'w-16 h-16', sm: 'w-14 h-14' } as const;

interface PhotoThumbRowProps {
  /** Saved photos to show with a remove control (the editor). Omit where they're shown elsewhere (timeline collage). */
  photos?: FeedPhoto[];
  pending: PendingPhoto[];
  canAdd: boolean;
  onAddFiles: (files: File[]) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
  onDelete?: (photo: FeedPhoto) => Promise<void>;
  notice?: string | null;
  /** For accessible names ("Remove photo 2 from Hamilton"). */
  title: string;
  size?: keyof typeof SIZE;
}

/**
 * Thumbnails + pending uploads + an "Add" tile, wrapping (no hidden
 * horizontal scroll). Remove is two taps: ✕ arms the tile as a Delete
 * confirm that reverts after 4s. A failed upload's tile is a Retry button;
 * "Discard" sits with the error text below the row.
 */
export default function PhotoThumbRow({
  photos = [], pending, canAdd, onAddFiles, onRetry, onDismiss, onDelete, notice, title, size = 'md',
}: PhotoThumbRowProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current); }, []);

  const savedIds = new Set(photos.map(p => p.id));
  // Done uploads already in `photos` render there; the rest still show as pending.
  const visiblePending = pending.filter(p => !savedIds.has(p.id));
  const failed = visiblePending.filter(p => p.status === 'failed');
  const box = SIZE[size];

  const arm = (id: string | null) => {
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(id);
    setDeleteError(null);
    if (id) armTimer.current = setTimeout(() => setArmed(null), 4000);
  };

  const confirmDelete = async (photo: FeedPhoto) => {
    if (!onDelete) return;
    if (armTimer.current) clearTimeout(armTimer.current);
    setDeleting(photo.id);
    try {
      await onDelete(photo);
      setArmed(null);
    } catch (e) {
      setDeleteError(e instanceof Error && e.message ? e.message : 'Couldn’t delete this photo. Try again.');
      setArmed(null);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div>
      <ul className="flex flex-wrap gap-2" aria-label={`Photos from ${title}`}>
        {photos.map((photo, i) => (
          <li key={photo.id} className={`relative ${box} rounded-lg overflow-hidden bg-surface-overlay`}>
            <ThumbImage src={photo.url} />
            {deleting === photo.id ? (
              <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-white" role="status">
                <Spinner />
                <span className="sr-only">Deleting photo</span>
              </span>
            ) : armed === photo.id ? (
              // Armed: the whole tile is the confirm, so it never competes
              // with a corner control for the 44px mobile tap area.
              <button
                type="button"
                onClick={() => confirmDelete(photo)}
                aria-label={`Confirm: delete photo ${i + 1} from ${title}`}
                className="absolute inset-0 flex items-center justify-center bg-black/70 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
              >
                <span className="px-2 py-1 rounded-full bg-score-skip text-white text-xs font-semibold">Delete</span>
              </button>
            ) : onDelete ? (
              // 44px tap area in the corner (the mobile minimum), 24px glyph.
              <button
                type="button"
                onClick={() => arm(photo.id)}
                aria-label={`Remove photo ${i + 1} from ${title}`}
                className="group/rm absolute top-0 right-0 w-11 h-11 flex items-start justify-end p-1 outline-none"
              >
                <span className="w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center group-hover/rm:bg-black/80 group-focus-visible/rm:ring-2 group-focus-visible/rm:ring-brand">
                  <XIcon className="w-3 h-3" />
                </span>
              </button>
            ) : null}
          </li>
        ))}
        {visiblePending.map(item => (
          <li key={item.id} className={`relative ${box} rounded-lg overflow-hidden bg-surface-overlay`}>
            <ThumbImage src={item.previewUrl} />
            {item.status === 'uploading' && (
              <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/55 text-white" role="status">
                <Spinner />
                <span className="text-xs font-semibold">Uploading</span>
              </span>
            )}
            {item.status === 'failed' && (
              <button
                type="button"
                onClick={() => onRetry(item.id)}
                aria-label="Upload failed. Retry"
                className="absolute inset-0 flex items-center justify-center bg-black/60 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
              >
                <span className="px-2 py-1 rounded-full bg-score-skip text-white text-xs font-semibold">Retry</span>
              </button>
            )}
          </li>
        ))}
        {canAdd && (
          <li className={box}>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              aria-label={`Add photos to ${title}`}
              className="w-full h-full rounded-lg border border-dashed border-white/20 bg-white/[0.03] text-gray-400 hover:text-white hover:border-white/40 flex flex-col items-center justify-center gap-0.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
              </svg>
              <span className="text-xs font-semibold">Add</span>
            </button>
            <PhotoFileInput inputRef={inputRef} onFiles={onAddFiles} />
          </li>
        )}
      </ul>
      {failed.length > 0 && (
        <div role="alert" className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-score-skip">
          <span>{failed.length === 1 ? failed[0].error : `${failed.length} photos didn’t upload. ${failed[0].error}`}</span>
          <button
            type="button"
            onClick={() => failed.forEach(p => onDismiss(p.id))}
            className="min-h-[32px] font-semibold text-gray-400 underline underline-offset-2 hover:text-white"
          >
            {failed.length === 1 ? 'Discard it' : 'Discard them'}
          </button>
        </div>
      )}
      {deleteError && <p role="alert" className="mt-2 text-xs text-score-skip">{deleteError}</p>}
      {notice && <p className="mt-2 text-xs text-gray-400">{notice}</p>}
    </div>
  );
}

/** Quiet inline "Add a photo" (or "Add more") for a timeline entry; no nagging. */
export function AddPhotoButton({ title, onAddFiles, label = 'Add a photo', className = '' }: {
  title: string;
  onAddFiles: (files: File[]) => void;
  label?: string;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        aria-label={`${label} to ${title}`}
        className={`inline-flex items-center gap-1.5 min-h-[32px] px-2 rounded-lg text-xs font-medium text-gray-400 hover:text-brand transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand ${className}`}
      >
        <CameraIcon className="w-4 h-4" />
        {label}
      </button>
      <PhotoFileInput inputRef={inputRef} onFiles={onAddFiles} />
    </>
  );
}
