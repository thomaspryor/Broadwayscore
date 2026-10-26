import type { Metadata } from 'next';
import { isFantasyListed } from '@/config/fantasy-listing';
import { versionedImagePath } from '@/lib/versioned-image-path';

// Unlisted until fantasy-season.json listedFrom (BRO-5483): the pages work by
// direct link but stay out of search results. Once listed, no robots key is
// returned, so the root layout's site-wide setting applies. /fantasy and
// /fantasy/guide regenerate every 15 minutes (revalidate), the other static
// pages flip at the first deploy on or after listedFrom, and the dynamic ones
// (leaderboard, league) flip per request. Every game page gets the marquee tab icon
// (BRO-5519, files from scripts/generate-fantasy-brand-assets.mjs).
const icons: Metadata['icons'] = {
  icon: [
    { url: versionedImagePath('/images/fantasy/marquee-icon.svg'), type: 'image/svg+xml' },
    { url: versionedImagePath('/images/fantasy/marquee-icon-32.png'), sizes: '32x32', type: 'image/png' },
  ],
  apple: versionedImagePath('/images/fantasy/marquee-icon-180.png'),
};

export function generateMetadata(): Metadata {
  return isFantasyListed() ? { icons } : { icons, robots: { index: false, follow: false } };
}

export default function FantasyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
