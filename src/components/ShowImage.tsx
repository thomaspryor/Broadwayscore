'use client';

import { useState, useMemo, ReactNode } from 'react';
import { getCdnSrcSet, getShowImageSrcSet } from '@/lib/images';
import { catchEarlyImgError } from '@/lib/img-early-error';

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
  // Source whose local variant srcset 404'd: retry that source's original before cascading.
  const [srcSetFailedFor, setSrcSetFailedFor] = useState<string | null>(null);

  const currentSrc = validSources[failedCount];

  const srcSet = useMemo(() => {
    if (!sizes || !currentSrc) return undefined;
    if (srcSetFailedFor === currentSrc) return undefined;
    const set = getCdnSrcSet(currentSrc) || getShowImageSrcSet(currentSrc);
    return set || undefined;
  }, [sizes, currentSrc, srcSetFailedFor]);

  // A missing sm/ variant makes the browser fail the whole <img> (it does not
  // fall back to src), so drop the srcset once and reload the original.
  const handleError = () => {
    if (srcSet && currentSrc && getShowImageSrcSet(currentSrc)) setSrcSetFailedFor(currentSrc);
    else setFailedCount(prev => prev + 1);
  };

  if (!currentSrc) return <>{fallback}</>;

  return (
    <img
      // A fresh element per source, so the early-error ref never reads the
      // previous source's failed state and skips a fallback untried.
      key={`${currentSrc}${srcSet ? '' : '#o'}`}
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
      ref={catchEarlyImgError(() => {
        if (srcSet && getShowImageSrcSet(currentSrc)) setSrcSetFailedFor(currentSrc);
        else setFailedCount(prev => (validSources[prev] === currentSrc ? prev + 1 : prev));
      })}
      onError={handleError}
    />
  );
}
