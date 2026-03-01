/**
 * Image optimization utilities for Contentful and Cloudinary CDNs
 *
 * Contentful supports: ?w=WIDTH&h=HEIGHT&fm=FORMAT&q=QUALITY&fit=fill
 * Cloudinary supports: /w_WIDTH,h_HEIGHT,c_fill,f_auto,q_auto/
 */

export type ImageSize = 'thumbnail' | 'card' | 'poster' | 'hero';

// Size presets for different use cases (width in pixels)
const SIZE_PRESETS: Record<ImageSize, { width: number; quality: number }> = {
  thumbnail: { width: 200, quality: 80 },   // 200px for retina-sharp list view thumbnails
  card: { width: 200, quality: 80 },       // ~200px cards in featured rows
  poster: { width: 300, quality: 85 },     // ~300px posters (largest display: 160px × 2x retina)
  hero: { width: 800, quality: 85 },       // Hero images (not currently used)
};

/**
 * Optimize a Contentful image URL
 * Uses fit=pad with dark background to preserve full image without bad cropping
 */
function optimizeContentfulUrl(url: string, width: number, quality: number): string {
  const baseUrl = url.split('?')[0]; // Remove any existing params
  return `${baseUrl}?w=${width}&fm=webp&q=${quality}&fit=pad&bg=rgb:121212`;
}

/**
 * Optimize a Cloudinary image URL
 */
function optimizeCloudinaryUrl(url: string, width: number, quality: number): string {
  // Cloudinary URLs: https://res.cloudinary.com/CLOUD/image/upload/VERSION/FILE
  // Insert transformation before version
  const uploadIndex = url.indexOf('/upload/');
  if (uploadIndex === -1) return url;

  const before = url.substring(0, uploadIndex + 8); // includes /upload/
  const after = url.substring(uploadIndex + 8);

  return `${before}w_${width},f_auto,q_${quality}/${after}`;
}

/**
 * Get optimized image URL based on CDN type
 */
export function getOptimizedImageUrl(url: string | undefined, size: ImageSize): string {
  if (!url) return '';

  const preset = SIZE_PRESETS[size];

  // Contentful CDN
  if (url.includes('images.ctfassets.net')) {
    return optimizeContentfulUrl(url, preset.width, preset.quality);
  }

  // Cloudinary CDN
  if (url.includes('res.cloudinary.com')) {
    return optimizeCloudinaryUrl(url, preset.width, preset.quality);
  }

  // S3 or other - can't optimize, return as-is
  return url;
}

/**
 * Get srcset for responsive images (Contentful only)
 */
export function getContentfulSrcSet(url: string | undefined, sizes: number[]): string {
  if (!url || !url.includes('images.ctfassets.net')) return '';

  const baseUrl = url.split('?')[0];
  return sizes
    .map(w => `${baseUrl}?w=${w}&fm=webp&q=80&fit=pad&bg=rgb:121212 ${w}w`)
    .join(', ');
}

/**
 * Generate a srcset string from a pre-optimized CDN URL.
 * Works with both Contentful and Cloudinary. Returns '' for local/unknown URLs.
 */
export function getCdnSrcSet(optimizedUrl: string | undefined, widths: number[] = [100, 200, 400, 800]): string {
  if (!optimizedUrl) return '';

  // Contentful: replace w=NNN in query params
  if (optimizedUrl.includes('images.ctfassets.net')) {
    const baseUrl = optimizedUrl.split('?')[0];
    return widths
      .map(w => `${baseUrl}?w=${w}&fm=webp&q=80&fit=pad&bg=rgb:121212 ${w}w`)
      .join(', ');
  }

  // Cloudinary: replace w_NNN in path segment
  if (optimizedUrl.includes('res.cloudinary.com')) {
    return widths
      .map(w => `${optimizedUrl.replace(/w_\d+/, `w_${w}`)} ${w}w`)
      .join(', ');
  }

  return '';
}

/**
 * Check if an image URL is from an optimizable CDN
 */
export function isOptimizableCDN(url: string | undefined): boolean {
  if (!url) return false;
  return url.includes('images.ctfassets.net') || url.includes('res.cloudinary.com');
}
