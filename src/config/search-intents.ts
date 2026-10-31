// Search-intent map (BRO-5988).
//
// Three registries rank overlapping lists of shows: /guides (guide-pages.ts),
// /browse (browse-pages.ts) and /best (BEST_OF_CONFIG in data-core.ts). Left
// alone they compete for the same queries (e.g. "best broadway musicals" is
// answered by /guides/best-broadway-musicals, /browse/best-broadway-musicals
// and /best/musicals). This file names ONE canonical URL per ranking intent and
// lists the other URLs that serve it as aliases. Each alias carries a title that
// targets a different angle (full list, top 10, by age, ...), so it stops
// competing instead of being redirected.
//
// Canonicals come from 90 days of Search Console query+page data
// (scripts/analyze-intent-page-overlap.js), then editorial depth where GSC has
// no signal. No 308s yet: redirects wait for two weeks of data on the retitled
// pages (follow-up card, RECHECK-AFTER 2026-11-12).
//
// Guide year variants (/guides/best-broadway-musicals-2026) fold into the base
// guide's intent via parseGuideSlug.

import { parseGuideSlug } from '@/config/guide-pages';

export interface SearchIntent {
  /** Stable id for the ranking intent. */
  id: string;
  /** The head query the canonical page should win. */
  query: string;
  /** The one URL that owns the intent. */
  canonical: string;
  /** Other URLs that serve the same shows list; each must keep a distinct title angle. */
  aliases: string[];
  /** GSC evidence or reason for the canonical pick. */
  why: string;
}

export const SEARCH_INTENTS: SearchIntent[] = [
  {
    id: 'top-rated-now',
    query: 'top rated broadway shows right now',
    canonical: '/best/highest-rated',
    aliases: ['/browse/best-broadway-show-right-now'],
    why: 'GSC: wins "top/best rated/ranked/right now" queries; the browse page is a single #1 pick, not a list',
  },
  {
    id: 'best-shows-now',
    query: 'best broadway shows',
    canonical: '/guides/best-broadway-shows',
    aliases: [],
    why: 'Head term guide; editorial intro and ticket CTAs. No other registry targets the bare head query.',
  },
  {
    id: 'highest-rated-all-time',
    query: 'highest rated broadway shows of all time',
    canonical: '/guides/highest-rated-broadway-shows',
    aliases: ['/browse/best-broadway-shows-all-time'],
    why: 'GSC: 259 clicks, wins "all time", "ranked" and "best broadway musicals of all time"',
  },
  {
    id: 'best-musicals',
    query: 'best broadway musicals',
    canonical: '/guides/best-broadway-musicals',
    aliases: ['/browse/best-broadway-musicals', '/best/musicals'],
    why: 'GSC: 138 clicks, wins "top 100", "2026" and recommendation queries',
  },
  {
    id: 'best-plays',
    query: 'best broadway plays',
    canonical: '/guides/best-broadway-plays',
    aliases: ['/browse/best-broadway-plays', '/best/plays'],
    why: 'Same shape as musicals: the guide has the editorial intro; browse is the full list, /best the top 10',
  },
  {
    id: 'new-shows',
    query: 'best new broadway shows',
    canonical: '/guides/best-new-broadway-shows',
    aliases: ['/browse/best-recent-shows', '/best/new-shows'],
    why: 'GSC: the browse and /best variants sit at pos 40 to 99; the guide carries the season editorial',
  },
  {
    id: 'comedies',
    query: 'best broadway comedies',
    canonical: '/browse/best-broadway-comedies',
    aliases: ['/best/comedy'],
    why: 'GSC: browse 21 clicks vs /best/comedy 4',
  },
  {
    id: 'dramas',
    query: 'best broadway dramas',
    canonical: '/browse/best-broadway-dramas',
    aliases: ['/best/drama'],
    why: 'Only browse has a dedicated intro; /best is the top 10 cut',
  },
  {
    id: 'kids-and-families',
    query: 'broadway shows for kids',
    canonical: '/guides/best-broadway-shows-for-kids',
    aliases: ['/browse/broadway-shows-for-kids', '/best/family'],
    why: 'GSC: the guide is the only one of the three with impressions for "broadway shows for kids" (pos 28)',
  },
  {
    id: 'teens',
    query: 'broadway shows for teens',
    canonical: '/browse/broadway-shows-for-teens',
    aliases: ['/guides/best-broadway-shows-for-teens'],
    why: 'GSC: browse 65 clicks at pos 5.6 vs guide 9 clicks at pos 12',
  },
  {
    id: 'date-night',
    query: 'broadway shows for date night',
    canonical: '/guides/broadway-shows-for-date-night',
    aliases: ['/browse/broadway-shows-for-date-night'],
    why: 'Both pages had the identical title; the guide has the editorial, browse becomes the full ranked list',
  },
  {
    id: 'first-timers',
    query: 'broadway shows for first time visitors',
    canonical: '/guides/best-broadway-shows-for-first-timers',
    aliases: ['/browse/first-time-broadway'],
    why: 'Both pages had the identical title; /browse/broadway-shows-for-tourists owns the "first-time visitors" long tail',
  },
  {
    id: 'revivals',
    query: 'best broadway revivals',
    canonical: '/guides/best-broadway-revivals',
    aliases: ['/browse/best-broadway-revivals'],
    why: 'Both pages had the identical title; the guide has the editorial, browse becomes the full ranked list',
  },
  {
    id: 'short-shows',
    query: 'short broadway shows',
    canonical: '/guides/short-broadway-shows',
    aliases: ['/browse/short-broadway-shows'],
    why: 'GSC: guide 15 clicks vs browse 4; browse already targets the under-90-minute angle',
  },
  {
    id: 'tony-winners',
    query: 'tony award winners on broadway',
    canonical: '/guides/tony-award-winners',
    aliases: ['/browse/tony-winners-on-broadway'],
    why: 'Guide carries the editorial; browse keeps the "now on Broadway" angle',
  },
  {
    id: 'jukebox-musicals',
    query: 'jukebox musicals on broadway',
    canonical: '/guides/best-jukebox-musicals',
    aliases: ['/browse/jukebox-musicals-on-broadway'],
    why: 'Guide carries the editorial; browse is the plain list',
  },
];

function normalize(path: string): string {
  const p = path.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return p || '/';
}

/** Fold /guides/<slug>-<year> into /guides/<slug>. */
function foldYear(path: string): string {
  const m = path.match(/^\/guides\/(.+)$/);
  if (!m) return path;
  return `/guides/${parseGuideSlug(m[1]).baseSlug}`;
}

/** Every URL that belongs to an intent (canonical first, then aliases). */
export function getIntentPaths(intent: SearchIntent): string[] {
  return [intent.canonical, ...intent.aliases];
}

/** The intent a URL serves, or undefined when the page is not part of the map. */
export function getIntentForPath(path: string): SearchIntent | undefined {
  const target = foldYear(normalize(path));
  return SEARCH_INTENTS.find((i) => getIntentPaths(i).includes(target));
}

/** True when the URL is the page that owns its intent (or is not in the map). */
export function isCanonicalPath(path: string): boolean {
  const intent = getIntentForPath(path);
  return !intent || intent.canonical === foldYear(normalize(path));
}
