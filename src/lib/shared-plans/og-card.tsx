import type { ImageResponse } from 'next/og';
import { renderShareCard, SHARE_OG_SIZE } from '@/lib/share-links/og-card';
import { plansSummary, plansTitle, type SharedPlansView } from './view-model';

/**
 * The Shared Plans link-preview card (BRO-4481): name, counts, up to four
 * posters. Used by src/app/plans/[token]/opengraph-image.tsx; kept separate
 * so it can be rendered and checked without a live share.
 */
export const PLANS_OG_SIZE = SHARE_OG_SIZE;

export function renderPlansCard(view: SharedPlansView): Promise<ImageResponse> {
  return renderShareCard({
    title: plansTitle(view.name),
    summary: plansSummary(view.counts),
    posterUrls: [...view.booked, ...view.unbooked].map(s => s.posterUrl),
  });
}
