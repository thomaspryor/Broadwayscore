import { getCdnSrcSet, getShowImageSrcSet, getShowImageVariantUrl } from '@/lib/images';
import { siteImageExists, versionedImagePath } from '@/lib/versioned-image-path';

/**
 * srcset for server-rendered <img> tags (no onError to recover with). A local
 * variant is advertised only when its file exists at build time, so a missing
 * `sm/` file can never produce a broken image (BRO-6277). Existence comes from
 * the site-image manifest, not fs: a dynamic public/ path makes the file tracer
 * bundle all of public/ into every route using this (BRO-6312).
 */
export function getServerImageSrcSet(url: string | undefined | null): string {
  if (!url) return '';
  const cdn = getCdnSrcSet(url);
  if (cdn) return cdn;
  // Card data carries ?v=<hash> (BRO-6197); the variant regexes want the bare path.
  const bare = url.split('?')[0];
  const variant = getShowImageVariantUrl(bare);
  if (!variant || !siteImageExists(variant)) return '';
  return getShowImageSrcSet(bare)
    .split(', ')
    .map(part => {
      const [u, w] = part.split(' ');
      return `${versionedImagePath(u)} ${w}`;
    })
    .join(', ');
}
