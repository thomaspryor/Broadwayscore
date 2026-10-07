import { pngToOgJpegResponse } from '@/lib/og-jpeg';
import { renderGenericShareCard } from '@/lib/share-links/og-card';
import { loadSharedPlansView } from '@/lib/shared-plans/load-view';
import { PLANS_OG_SIZE, renderPlansCard } from '@/lib/shared-plans/og-card';

/**
 * Link-preview card for /plans/<token> (BRO-4481). Built from the token on
 * the server — nothing on it comes from URL parameters, so nobody can mint a
 * fake branded card. An unknown, stopped or reset link gets the generic card.
 */
export const alt = 'Theater plans on Broadway Scorecard';
export const size = PLANS_OG_SIZE;
export const contentType = 'image/jpeg';
// Live data: render per request; let shared caches hold it for 10 minutes
// (chat apps fetch it in bursts when a link is pasted into a group).
export const dynamic = 'force-dynamic';
const CACHE = 'public, max-age=600, s-maxage=600';

export default async function PlansOGImage({ params }: { params: { token: string } }) {
  const data = await loadSharedPlansView(params.token);
  return pngToOgJpegResponse(data.status === 'ok' ? await renderPlansCard(data.view) : await renderGenericShareCard(), CACHE);
}
