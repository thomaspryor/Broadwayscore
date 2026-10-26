import fs from 'fs';
import path from 'path';
import { getCdnSrcSet, getShowImageSrcSet, getShowImageVariantUrl } from '@/lib/images';

/**
 * srcset for server-rendered <img> tags (no onError to recover with). A local
 * variant is advertised only when its file exists at build time, so a missing
 * `sm/` file can never produce a broken image (BRO-6277).
 */
export function getServerImageSrcSet(url: string | undefined | null): string {
  if (!url) return '';
  const cdn = getCdnSrcSet(url);
  if (cdn) return cdn;
  const variant = getShowImageVariantUrl(url);
  if (!variant || !fs.existsSync(path.join(process.cwd(), 'public', variant))) return '';
  return getShowImageSrcSet(url);
}
