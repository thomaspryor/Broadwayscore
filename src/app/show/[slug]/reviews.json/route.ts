// Review rows past the first few, fetched by ReviewsList (BRO-6278). Static like the page.
import { notFound } from 'next/navigation';
import { getShowBySlug, getRecentShowSlugs } from '@/lib/data-core';
import { isCategoryEnabled } from '@/lib/markets';
import { getReviewListItems, REVIEWS_INLINE_COUNT } from '@/lib/show-review-items';

export const dynamic = 'force-static';
export const revalidate = 86400;

export function generateStaticParams() {
  return getRecentShowSlugs().map(slug => ({ slug }));
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const show = getShowBySlug(slug);
  if (!show || !isCategoryEnabled(show.category)) notFound();
  return Response.json(getReviewListItems(show).slice(REVIEWS_INLINE_COUNT));
}
