// Link previews for the game's pages (BRO-5529). A page that sets no
// openGraph or twitter inherits the root layout's homepage card, and one that
// sets only openGraph used to preview as the homepage on X, so every fantasy
// metadata export spreads this (tests/unit/fantasy-social-metadata.test.mjs).
import type { Metadata } from 'next';
import { BASE_URL } from '@/lib/seo';
import { FANTASY_OG_IMAGE } from './fantasy-listing';

export const FANTASY_SOCIAL_LINE = 'Pick your Broadway shows once and they score all season. The best team on Tony night wins.';

export function fantasySocial(
  title: string,
  path: string,
  description: string = FANTASY_SOCIAL_LINE,
): Pick<Metadata, 'openGraph' | 'twitter'> {
  const url = `${BASE_URL}${path}`;
  const image = { url: `${BASE_URL}${FANTASY_OG_IMAGE}`, width: 1200, height: 630, alt: 'Broadway Fantasy League' };
  return {
    // A page's openGraph replaces the root layout's wholesale, so the site
    // name, type and locale it would otherwise inherit are restated here.
    openGraph: { type: 'website', locale: 'en_US', siteName: 'Broadway Scorecard', title, description, url, images: [image] },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}
