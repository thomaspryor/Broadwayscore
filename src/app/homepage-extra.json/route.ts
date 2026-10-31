import { buildHomepageExtra } from '@/lib/homepage-extra';

export const dynamic = 'force-static';

// Homepage shelves and Off-Broadway/West End search entries, fetched by
// HomePageClient once the shelves scroll into view or the visitor searches
// (BRO-6278). Kept out of the page's inlined flight data.
export function GET() {
  return Response.json(buildHomepageExtra());
}
