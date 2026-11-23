// Review rows past the first few, fetched by ReviewsList (BRO-6278). Static like the page.
import { notFound } from 'next/navigation';
import { getRecentShowSlugs } from '@/lib/data-core';
import { getShowForRender } from '@/lib/show-render';
import { showRefreshEnabled, SHOW_REFRESH_REV_HEADER } from '@/lib/show-refresh-core';
import { isCategoryEnabled } from '@/lib/markets';
import { getReviewListItems, REVIEWS_INLINE_COUNT } from '@/lib/show-review-items';

export const dynamic = 'force-static';
export const revalidate = 86400;

export function generateStaticParams() {
  return getRecentShowSlugs().map(slug => ({ slug }));
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const render = await getShowForRender(slug);
  const show = render?.show;
  if (!show || !isCategoryEnabled(show.category)) notFound();
  const rows = getReviewListItems(show).slice(REVIEWS_INLINE_COUNT);
  // BRO-8056 refresh marker (plan row 10), only while the reader is on.
  return Response.json(rows, showRefreshEnabled() ? { headers: { [SHOW_REFRESH_REV_HEADER]: render?.rev ?? 'base' } } : undefined);
}
