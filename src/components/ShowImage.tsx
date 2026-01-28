'use client';

import { useState, ReactNode } from 'react';

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
}

/**
 * Image component with cascading source fallback and error handling.
 * Tries each source URL in order; if all fail, renders the fallback.
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
}: ShowImageProps) {
  const validSources = sources.filter((s): s is string => !!s);
  const [failedCount, setFailedCount] = useState(0);

  const currentSrc = validSources[failedCount];

  if (!currentSrc) return <>{fallback}</>;

  return (
    <img
      src={currentSrc}
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
