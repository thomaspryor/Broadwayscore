'use client';

import { useState, useMemo, ReactNode } from 'react';
import { getCdnSrcSet } from '@/lib/images';

interface ShowImageProps {
  /** Image URLs to try in order (nulls/undefined filtered out) */
  sources: (string | undefined | null)[];
  alt: string;
  /** Rendered when all sources fail or none provided */
  fallback: ReactNode;
  className?: string;
  width?: number;
  height?: number;
  loading?: 'eager' | 'lazy';
  priority?: boolean;
  decoding?: 'async' | 'sync' | 'auto';
  ariaHidden?: boolean;
  /** HTML sizes attribute — when provided, auto-generates srcSet for CDN images */
  sizes?: string;
}

/**
 * Image component with cascading source fallback and error handling.
 * Tries each source URL in order; if all fail, renders the fallback.
 * When `sizes` is provided, generates responsive srcSet for Contentful/Cloudinary images.
 */
export default function ShowImage({
  sources,
  alt,
  fallback,
  className,
  width,
  height,
  loading,
  priority,
  decoding,
  ariaHidden,
  sizes,
}: ShowImageProps) {
  const validSources = sources.filter((s): s is string => !!s);
  const [failedCount, setFailedCount] = useState(0);

  const currentSrc = validSources[failedCount];

  const srcSet = useMemo(() => {
    if (!sizes || !currentSrc) return undefined;
    const set = getCdnSrcSet(currentSrc);
    return set || undefined;
  }, [sizes, currentSrc]);

  if (!currentSrc) return <>{fallback}</>;

  return (
    <img
      src={currentSrc}
      srcSet={srcSet}
      sizes={srcSet ? sizes : undefined}
      alt={alt}
      className={className}
      width={width}
      height={height}
      loading={priority ? 'eager' : loading}
      fetchPriority={priority ? 'high' : undefined}
      decoding={decoding}
      aria-hidden={ariaHidden}
      onError={() => setFailedCount(prev => prev + 1)}
    />
  );
}
