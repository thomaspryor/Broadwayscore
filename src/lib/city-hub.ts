// Pure sectioning for city hub pages (BRO-6517). A hub lists a metro's tour
// stops and its regional/local productions in Now playing / Coming soon /
// Recently closed. Closed shows older than RECENT_DAYS move to an archive
// list so a hub fed by ~1,000 local productions (BRO-6518) stays short.

export const RECENT_DAYS = 365;
export const CLOSED_LIMIT = 12;

/** Slug of the one metro that has a hub page today. */
export const HUB_CITIES: Record<string, { name: string; short: string }> = {
  'chicago-il': { name: 'Chicago, IL', short: 'Chicago' },
};

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
  const mine = shows.filter(s => s.city === metro);
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
