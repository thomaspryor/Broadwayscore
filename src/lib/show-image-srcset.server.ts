import { getCdnSrcSet, getShowImageSrcSet, getShowImageVariantUrl } from '@/lib/images';
import { siteImageExists } from '@/lib/versioned-image-path';

/**
 * srcset for server-rendered <img> tags (no onError to recover with). A local
 * variant is advertised only when the build manifest lists it, so a missing
 * `sm/` file can never produce a broken image (BRO-6277). The manifest is used
 * instead of fs.existsSync(process.cwd()/public/...): a dynamic cwd path makes
 * Next trace all of public/images into serverless functions, which broke prod
 * deploys (function size, ~1.4GB upload).
 */
export function getServerImageSrcSet(url: string | undefined | null): string {
  if (!url) return '';
  const cdn = getCdnSrcSet(url);
  if (cdn) return cdn;
  const variant = getShowImageVariantUrl(url);
  if (!variant || !siteImageExists(variant.split('?')[0])) return '';
  return getShowImageSrcSet(url);
}
