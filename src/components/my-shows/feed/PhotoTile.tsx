'use client';

import { useState } from 'react';
import { catchEarlyImgError } from '@/lib/img-early-error';

/**
 * One clickable photo filling its box (object-cover). A failed load (e.g. an
 * expired signed URL) shows a quiet placeholder instead of a broken icon.
 */
export default function PhotoTile({ url, label, onOpen, className = '', children }: {
  url: string;
  label: string;
  onOpen: () => void;
  className?: string;
  children?: React.ReactNode;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className={`group/photo relative block overflow-hidden bg-surface-overlay outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand ${className}`}
    >
      {broken ? (
        <span className="absolute inset-0 flex items-center justify-center text-fg-muted" aria-hidden="true">
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.16-5.16a2.25 2.25 0 013.18 0l5.16 5.16m-1.5-1.5l1.41-1.41a2.25 2.25 0 013.18 0l2.91 2.91M3.75 21h16.5A1.5 1.5 0 0021.75 19.5V4.5A1.5 1.5 0 0020.25 3H3.75A1.5 1.5 0 002.25 4.5v15A1.5 1.5 0 003.75 21zM15.75 8.25h.008v.008h-.008V8.25z" />
          </svg>
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover/photo:scale-[1.03]"
          ref={catchEarlyImgError(() => setBroken(true))}
          onError={() => setBroken(true)}
        />
      )}
      {children}
    </button>
  );
}
