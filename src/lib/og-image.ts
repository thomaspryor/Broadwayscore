/**
 * Shared helpers for opengraph-image routes (extracted from
 * src/app/show/[slug]/opengraph-image.tsx for Shared Plans, BRO-4481). The
 * PNG→JPEG re-encode lives in src/lib/og-jpeg.ts.
 */
import { BASE_URL } from '@/lib/seo';
import sharp from 'sharp';

/**
 * Fetch a show image as a data URI Satori can embed. Satori can't decode
 * WebP. Ask the optimizer for JPEG/PNG, but convert WebP locally when the
 * optimizer passes the original format through. Returns null on any failure.
 */
export async function fetchImageDataUri(imagePath: string, width: number): Promise<string | null> {
  // Same-origin /images/** only: the optimizer's GHSA-2xp9-vwfh-vxw4 exposure
  // assessment (scripts/audit-dependencies.js, tests/unit/image-optimizer-
  // exposure.test.mjs) assumes no caller passes third-party URLs. Diary-only
  // shows can carry remote poster URLs; they are skipped, not proxied.
  if (!isSameOriginImagePath(imagePath)) return null;
  try {
    const url = `${BASE_URL}/_next/image?url=${encodeURIComponent(imagePath)}&w=${width}&q=75`;
    const res = await fetch(url, { headers: { Accept: 'image/jpeg,image/png' } });
    if (!res.ok) return null;
    let contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(jpeg|png|webp)$/.test(contentType)) return null;
    let buf = Buffer.from(await res.arrayBuffer());
    if (contentType === 'image/webp') {
      buf = await sharp(buf).resize({ width, withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
      contentType = 'image/jpeg';
    }
    return `data:${contentType};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/** True for a site-relative /images/** path (no scheme, host or traversal). */
export function isSameOriginImagePath(imagePath: string): boolean {
  return imagePath.startsWith('/images/') && !imagePath.includes('..') && !imagePath.includes('//');
}
