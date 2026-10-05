import { getAllShows } from '@/lib/data-core';
import { getMarketDate } from '@/lib/date-utils';
import { pickWelcomeShows } from '@/lib/welcome-onboarding';

// Built once per deploy: the poster grid in the welcome sheet (BRO-4619).
// A route rather than a public/data file so it needs no generator step and is
// always computed from the same data as the rest of the build.
export const dynamic = 'force-static';

export async function GET() {
  const shows = pickWelcomeShows(
    getAllShows().map(s => ({
      id: s.id,
      title: s.title,
      slug: s.slug,
      status: s.status,
      category: s.category,
      openingDate: s.openingDate,
      closingDate: s.closingDate,
      images: s.images,
      reviewCount: s.criticScore?.reviewCount ?? 0,
    })),
    getMarketDate('broadway'),
  );
  return Response.json({ shows });
}
