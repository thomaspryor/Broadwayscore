import type { Metadata } from 'next';
import { isFantasyListed } from '@/config/fantasy-listing';

// Unlisted until fantasy-season.json listedFrom (BRO-5483): the pages work by
// direct link but stay out of search results. Returning {} inherits the
// site-wide robots setting from the root layout. Static pages flip at the
// first deploy on or after listedFrom; the dynamic ones (leaderboard, league)
// flip per request.
export function generateMetadata(): Metadata {
  return isFantasyListed() ? {} : { robots: { index: false, follow: false } };
}

export default function FantasyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
