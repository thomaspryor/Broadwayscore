import { getSiteStats } from '@/lib/data-core';

export const dynamic = 'force-static';

// The site-wide headline counts, read by the iOS Home subtitle (lib/site-stats-source.ts
// in the app repo) so the app shows exactly the numbers the homepage shows.
export function GET() {
  return Response.json({ _v: 1, ...getSiteStats() });
}
