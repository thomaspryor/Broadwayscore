'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * Profile avatar that degrades to `fallback` (initials or the user glyph) when
 * the URL is dead, so a broken-image glyph is never the only affordance
 * (BRO-4303). Resets when the URL changes.
 */
export default function AvatarImage({
  src, className, fallback,
}: {
  src: string | null | undefined;
  className?: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) return <>{fallback}</>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className={className} onError={() => setFailed(true)} />;
}
