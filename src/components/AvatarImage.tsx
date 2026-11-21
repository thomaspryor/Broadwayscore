'use client';

import { useState, type ReactNode } from 'react';
import { catchEarlyImgError } from '@/lib/img-early-error';

/**
 * Profile avatar that degrades to `fallback` (initials or the user glyph) when
 * the URL is dead, so a broken-image glyph is never the only affordance
 * (BRO-4303). The failure is keyed to the URL that failed, so a new URL gets
 * a fresh try with no fallback frame in between.
 */
export default function AvatarImage({
  src, className, fallback,
}: {
  src: string | null | undefined;
  className?: string;
  fallback: ReactNode;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || failedSrc === src) return <>{fallback}</>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className={className} ref={catchEarlyImgError(() => setFailedSrc(src))} onError={() => setFailedSrc(src)} />;
}
