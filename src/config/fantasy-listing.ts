// Whether the Fantasy League is findable from the rest of the site (BRO-5483).
// Before listedFrom (fantasy-season.json, a New York date) the game's pages
// work by direct link, but the footer and homepage do not link to them and
// they ask search engines not to index them. Kept apart from fantasy.ts so the
// root layout imports only this and the season JSON.
import seasonConfig from './fantasy-season.json';
import { featureFlags } from './feature-flags';

/**
 * The link-preview image for every game page (public/og/fantasy.png, drawn by
 * scripts/generate-fantasy-brand-assets.mjs). Bump the version when the image
 * changes: social sites cache previews by URL (BRO-5519 moved to the marquee).
 */
export const FANTASY_OG_IMAGE = '/og/fantasy.png?v=marquee';

export const LISTED_FROM: string = (seasonConfig as { listedFrom?: string }).listedFrom ?? seasonConfig.draftOpens;

const nyDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** True once the game should be findable: the feature is on and listedFrom has arrived in New York. */
export function isFantasyListed(now: Date = new Date()): boolean {
  return featureFlags.fantasyLeague && nyDay.format(now) >= LISTED_FROM;
}
