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
export async function fetchImageDataUri(
  imagePath: string,
  width: number,
  { retryDelayMs = 400 }: { retryDelayMs?: number } = {},
): Promise<string | null> {
  // Same-origin /images/** only: the optimizer's GHSA-2xp9-vwfh-vxw4 exposure
  // assessment (scripts/audit-dependencies.js, tests/unit/image-optimizer-
  // exposure.test.mjs) assumes no caller passes third-party URLs. Diary-only
  // shows can carry remote poster URLs; they are skipped, not proxied.
  if (!isSameOriginImagePath(imagePath)) return null;
  try {
    // Show art carries a ?v=<md5> cache-buster (versionedImagePath, BRO-6197).
    // The optimizer 400s (INVALID_IMAGE_OPTIMIZE_REQUEST) on a local path with a
    // query string, which sent every show to the generic share card. It only
    // needs the file path, so drop the query and fragment.
    const barePath = imagePath.split(/[?#]/)[0];
    const url = `${BASE_URL}/_next/image?url=${encodeURIComponent(barePath)}&w=${width}&q=75`;
    // A static build asks the optimizer for thousands of images across parallel
    // workers; a dropped connection or 429/5xx there is transient, and without
    // a retry it silently degrades the show to the generic share card (BRO-3204).
    // 4xx other than 429 (a dead pointer) is not retried.
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(url, { headers: { Accept: 'image/jpeg,image/png' }, signal: AbortSignal.timeout(8000) });
        if (res.ok || (res.status !== 429 && res.status < 500)) break;
        if (attempt < 2) await res.body?.cancel();
      } catch {
        res = null;
      }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
    if (!res || !res.ok) return null;
    let contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(jpeg|png|webp)$/.test(contentType)) return null;
    let buf = Buffer.from(await res.arrayBuffer());
    // Trust the bytes, not the header: many show images are WebP saved as
    // .jpg, and the optimizer can pass them through labelled image/jpeg.
    // Satori then throws "Invalid JPEG" and fails the whole static build.
    const sniffed = sniffImageType(buf);
    if (!sniffed) return null;
    contentType = sniffed;
    if (contentType === 'image/webp') {
      buf = await sharp(buf).resize({ width, withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
      contentType = 'image/jpeg';
    }
    return `data:${contentType};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/** Image type from magic bytes (JPEG, PNG, WebP), or null for anything else. */
export function sniffImageType(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** True for a site-relative /images/** path (no scheme, host or traversal). */
export function isSameOriginImagePath(imagePath: string): boolean {
  return imagePath.startsWith('/images/') && !imagePath.includes('..') && !imagePath.includes('//');
}
