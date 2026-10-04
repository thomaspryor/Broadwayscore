import { pngToOgJpegResponse } from '@/lib/og-jpeg';
import { renderGenericShareCard, SHARE_OG_SIZE } from '@/lib/share-links/og-card';
import { loadSharedDiaryView } from '@/lib/shared-diary/load-view';
import { renderDiaryCard } from '@/lib/shared-diary/og-card';

/**
 * Link-preview card for /seen/<token> (BRO-4566). Built from the token on
 * the server; nothing on it comes from URL parameters. An unknown, stopped
 * or reset link gets the generic card.
 */
export const alt = 'Theater diary on Broadway Scorecard';
export const size = SHARE_OG_SIZE;
export const contentType = 'image/jpeg';
// Live data: render per request; shared caches may hold it for 10 minutes.
export const dynamic = 'force-dynamic';
const CACHE = 'public, max-age=600, s-maxage=600';

export default async function DiaryOGImage({ params }: { params: { token: string } }) {
  const data = await loadSharedDiaryView(params.token);
  return pngToOgJpegResponse(data.status === 'ok' ? await renderDiaryCard(data.view) : await renderGenericShareCard(), CACHE);
}
