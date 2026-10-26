// Deferred below-fold props for a show page (BRO-6278). Static like the page:
// recent shows are prerendered, the rest are generated on first request and
// cached until the next deploy.
import { notFound } from 'next/navigation';
import { getShowBySlug, getRecentShowSlugs } from '@/lib/data-core';
import { isCategoryEnabled } from '@/lib/markets';
import { getShowBelowFoldDeferred } from '@/lib/show-below-fold-data';

export const dynamic = 'force-static';
export const revalidate = 86400;

export function generateStaticParams() {
  return getRecentShowSlugs().map(slug => ({ slug }));
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const show = getShowBySlug(slug);
  if (!show || !isCategoryEnabled(show.category)) notFound();
  return Response.json(getShowBelowFoldDeferred(show));
}
