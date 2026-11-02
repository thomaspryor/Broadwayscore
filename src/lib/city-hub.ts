// Pure sectioning for city hub pages (BRO-6517). A hub lists a metro's tour
// stops and its regional/local productions in Now playing / Coming soon /
// Recently closed. Closed shows older than RECENT_DAYS move to an archive
// list so a hub fed by ~1,000 local productions (BRO-6518) stays short.

export const RECENT_DAYS = 365;
export const CLOSED_LIMIT = 12;

import registry from '../../data/city-hubs.json';

export interface HubCity {
  name: string;
  short: string;
  home: string;
  since?: string;
  emoji: string;
  /** Footer card headline ("DC"). */
  cardLabel: string;
  /** Market-menu line after "N playing now · ". */
  menuSub: string;
  /** Key of the app's CITY_MARKETS entry (BroadwayScorecard-app lib/market-filter.ts). */
  appMarket: string;
  /** shows.json discoverySource of this city's local productions (also the local-only marker). */
  discoverySource: string;
  /** false = staged: no menu, footer, sitemap, route or stats exposure. */
  launched: boolean;
}

/** Every registry city, staged ones included. data/city-hubs.json is the one place a city is added (BRO-6833). */
export const ALL_HUB_CITIES: Record<string, HubCity> = Object.fromEntries(
  Object.entries(registry.hubs as Record<string, Partial<HubCity>>).map(([slug, h]) => [slug, { ...h, launched: h.launched === true } as HubCity]),
);

/** Slugs of the launched metros that have a hub page. `home` is the trailing "City, ST" a venue drops on that hub's own page. */
export const HUB_CITIES: Record<string, HubCity> = Object.fromEntries(
  Object.entries(ALL_HUB_CITIES).filter(([, h]) => h.launched),
);

/** "Arena Stage, Washington, DC" -> "Arena Stage" on the DC hub; suburbs keep their city. */
export function hubVenue(venue: string | null | undefined, slug: string): string {
  const home = HUB_CITIES[slug]?.home;
  if (!venue || !home) return venue || '';
  const esc = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/,\s*/g, ',\\s*');
  return venue.replace(new RegExp(`,\\s*${esc}$`), '');
}

export interface HubShowLike {
  id: string;
  city?: string | null;
  status?: string;
  openingDate?: string | null;
  closingDate?: string | null;
}

export type HubPhase = 'now' | 'soon' | 'closed';

/** Where a production falls today. A missing closing date on a closed show counts as closed at its opening. */
export function hubPhase(s: HubShowLike, today: string): HubPhase {
  const open = s.openingDate || '';
  const close = s.closingDate || '';
  if (s.status === 'closed') return 'closed';
  if (close && close < today) return 'closed';
  if (s.status === 'previews') return 'now';
  if (open && open > today) return 'soon';
  if (s.status === 'upcoming') return 'soon';
  return 'now';
}

const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const endOf = (s: HubShowLike) => s.closingDate || s.openingDate || '';

export interface HubSections<T> {
  now: T[];
  soon: T[];
  closedRecent: T[];
  /** Closed more than RECENT_DAYS ago, or past the CLOSED_LIMIT cut. */
  archive: T[];
}

/**
 * Shows a city hub may list: every regional production, local-only ones included
 * (Chicago's own theatre, BRO-6518), minus UK flagship houses, which belong to
 * the West End side. getRegionalShows() withholds local-only shows because the
 * homepage and Pre-Broadway shelf must not carry them; the hub is where they live.
 */
export function hubCandidates<T extends { category?: string }>(shows: T[], isUkRegional: (s: T) => boolean): T[] {
  return shows.filter(s => s.category === 'regional' && !isUkRegional(s));
}

export function sectionHubShows<T extends HubShowLike>(shows: T[], metro: string, today: string): HubSections<T> {
  const cutoff = HUB_CITIES[metro]?.since;
  const mine = shows.filter(s => s.city === metro && !(cutoff && hubPhase(s, today) === 'closed' && (s.openingDate || '') < cutoff));
  const out: HubSections<T> = { now: [], soon: [], closedRecent: [], archive: [] };
  const since = addDays(today, -RECENT_DAYS);
  const closed: T[] = [];
  for (const s of mine) {
    const p = hubPhase(s, today);
    if (p === 'now') out.now.push(s);
    else if (p === 'soon') out.soon.push(s);
    else closed.push(s);
  }
  out.now.sort((a, b) => (b.openingDate || '').localeCompare(a.openingDate || ''));
  out.soon.sort((a, b) => (a.openingDate || '9999').localeCompare(b.openingDate || '9999'));
  closed.sort((a, b) => endOf(b).localeCompare(endOf(a)) || a.id.localeCompare(b.id));
  const recent = closed.filter(s => endOf(s) >= since);
  out.closedRecent = recent.slice(0, CLOSED_LIMIT);
  out.archive = [...recent.slice(CLOSED_LIMIT), ...closed.filter(s => endOf(s) < since)];
  return out;
}
