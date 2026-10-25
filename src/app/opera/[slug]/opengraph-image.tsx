import OGImage, {
  alt as showAlt,
  size as showSize,
  contentType as showContentType,
} from '@/app/show/[slug]/opengraph-image';
import { getOperaShows, getOperaShowByTitleSlug, getOperaTitleSlug } from '@/lib/data-core';

// Delegates to show/[slug]/opengraph-image.tsx's renderer — this route only
// translates the opera title-slug (e.g. "macbeth") to the show's canonical
// slug (e.g. "macbeth-off-broadway-2026") that renderer expects. Without a
// file here, Next's file-based metadata convention has nothing to auto-inject
// into openGraph.images/twitter.images for /opera pages (page.tsx reuses
// show/[slug]'s generateMetadata as a plain function call, which doesn't
// carry over image auto-detection across route segments) — every opera-show
// share previously got zero og:image/twitter:image tags.

export const alt = showAlt;
export const size = showSize;
export const contentType = showContentType;
export const revalidate = 86400;
export const dynamicParams = true;

export function generateStaticParams() {
  return getOperaShows().map(s => ({ slug: getOperaTitleSlug(s.slug) }));
}

export default async function OperaOGImage({ params }: { params: { slug: string } }) {
  const show = getOperaShowByTitleSlug(params.slug);
  return OGImage({ params: { slug: show?.slug ?? params.slug } });
}
