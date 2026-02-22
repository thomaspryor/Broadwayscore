// Tony nominations person-level data module
// Imports: tony-nominations.json (~220 KB)
// Import directly — NOT through data.ts barrel (bundle protection)

import tonyData from '../../data/tony-nominations.json';
import { isActingCategory } from '@/config/awards';

// ============================================
// Types
// ============================================

export interface TonyNomination {
  season: string;
  ceremony: number;
  showId: string;
  category: string;
  name: string;
  ibdbPersonId: string;
  won: boolean;
}

export interface PersonTonyStats {
  nominations: number;
  wins: number;
  actingNominations: number;
  actingWins: number;
  entries: TonyNomination[];
}

export interface LeaderboardEntry {
  name: string;
  ibdbPersonId: string;
  nominations: number;
  wins: number;
  actingNominations: number;
  actingWins: number;
  categories: string[];
  shows: string[]; // unique showIds
  actingShowCount: number;
  creativeShowCount: number;
}

interface TonyNominationsFile {
  _meta: {
    description: string;
    lastUpdated: string;
    source: string;
    coverage: string;
    expectedShowCount: number;
    actualShowCount: number;
    totalNominations: number;
    totalWins: number;
  };
  nominations: TonyNomination[];
}

// ============================================
// Lazy-init memoized indexes
// ============================================

const data = tonyData as unknown as TonyNominationsFile;

// person ID → nominations
let byPersonId: Map<string, TonyNomination[]> | null = null;
// show ID → nominations
let byShowId: Map<string, TonyNomination[]> | null = null;
// person name → nominations (for creative profiles without ibdbPersonId)
let byName: Map<string, TonyNomination[]> | null = null;
// person ID → LeaderboardEntry (sorted by wins desc)
let leaderboardCache: LeaderboardEntry[] | null = null;

function ensurePersonIndex() {
  if (byPersonId) return;
  byPersonId = new Map();
  for (const nom of data.nominations) {
    if (!nom.ibdbPersonId) continue;
    const existing = byPersonId.get(nom.ibdbPersonId);
    if (existing) {
      existing.push(nom);
    } else {
      byPersonId.set(nom.ibdbPersonId, [nom]);
    }
  }
}

function ensureShowIndex() {
  if (byShowId) return;
  byShowId = new Map();
  for (const nom of data.nominations) {
    const existing = byShowId.get(nom.showId);
    if (existing) {
      existing.push(nom);
    } else {
      byShowId.set(nom.showId, [nom]);
    }
  }
}

function ensureNameIndex() {
  if (byName) return;
  byName = new Map();
  for (const nom of data.nominations) {
    if (!nom.name || nom.name === '(show-level)') continue;
    const existing = byName.get(nom.name);
    if (existing) {
      existing.push(nom);
    } else {
      byName.set(nom.name, [nom]);
    }
  }
}

// ============================================
// Public API
// ============================================

/**
 * Get all Tony nominations for a person by IBDB person ID
 */
export function getTonyNominationsByPersonId(ibdbPersonId: string): TonyNomination[] {
  ensurePersonIndex();
  return byPersonId!.get(ibdbPersonId) || [];
}

/**
 * Get all Tony nominations for a show by show ID
 */
export function getTonyNominationsByShowId(showId: string): TonyNomination[] {
  ensureShowIndex();
  return byShowId!.get(showId) || [];
}

/**
 * Get aggregated Tony stats for a person
 */
export function getPersonTonyStats(ibdbPersonId: string): PersonTonyStats | null {
  const entries = getTonyNominationsByPersonId(ibdbPersonId);
  if (entries.length === 0) return null;

  const actingEntries = entries.filter(n => isActingCategory(n.category));

  return {
    nominations: entries.length,
    wins: entries.filter(n => n.won).length,
    actingNominations: actingEntries.length,
    actingWins: actingEntries.filter(n => n.won).length,
    entries,
  };
}

/**
 * Check if a person won a Tony for a specific show
 */
export function hasPersonTonyForShow(ibdbPersonId: string, showId: string): { nominated: boolean; won: boolean } {
  const entries = getTonyNominationsByPersonId(ibdbPersonId);
  const showEntries = entries.filter(n => n.showId === showId);
  if (showEntries.length === 0) return { nominated: false, won: false };
  return {
    nominated: true,
    won: showEntries.some(n => n.won),
  };
}

/**
 * Get all Tony nominations for a person by name (for creative profiles without ibdbPersonId)
 */
export function getTonyNominationsByName(name: string): TonyNomination[] {
  ensureNameIndex();
  return byName!.get(name) || [];
}

/**
 * Get aggregated Tony stats for a person by name
 */
export function getPersonTonyStatsByName(name: string): PersonTonyStats | null {
  const entries = getTonyNominationsByName(name);
  if (entries.length === 0) return null;

  const actingEntries = entries.filter((n: TonyNomination) => isActingCategory(n.category));

  return {
    nominations: entries.length,
    wins: entries.filter((n: TonyNomination) => n.won).length,
    actingNominations: actingEntries.length,
    actingWins: actingEntries.filter((n: TonyNomination) => n.won).length,
    entries,
  };
}

/** Serializable per-show Tony info for passing as props */
export interface ShowTonyInfo {
  nominated: boolean;
  won: boolean;
  categories: string[];
}

/**
 * Compute per-show Tony info for a person (by ibdbPersonId).
 * Returns a plain object suitable for serialization as React props.
 */
export function getShowTonyMap(ibdbPersonId: string): Record<string, ShowTonyInfo> {
  const entries = getTonyNominationsByPersonId(ibdbPersonId);
  const result: Record<string, ShowTonyInfo> = {};
  for (const nom of entries) {
    if (!result[nom.showId]) {
      result[nom.showId] = { nominated: true, won: nom.won, categories: [nom.category] };
    } else {
      if (nom.won) result[nom.showId].won = true;
      result[nom.showId].categories.push(nom.category);
    }
  }
  return result;
}

/**
 * Compute per-show Tony info for a person (by name).
 */
export function getShowTonyMapByName(name: string): Record<string, ShowTonyInfo> {
  const entries = getTonyNominationsByName(name);
  const result: Record<string, ShowTonyInfo> = {};
  for (const nom of entries) {
    if (!result[nom.showId]) {
      result[nom.showId] = { nominated: true, won: nom.won, categories: [nom.category] };
    } else {
      if (nom.won) result[nom.showId].won = true;
      result[nom.showId].categories.push(nom.category);
    }
  }
  return result;
}

/**
 * Get Tony nominee info for a specific show, keyed by ibdbPersonId.
 * Used to add Tony tags to show detail page cast sections.
 */
export function getShowCastTonyMap(showId: string): Record<string, ShowTonyInfo> {
  ensureShowIndex();
  const noms = byShowId!.get(showId) || [];
  const result: Record<string, ShowTonyInfo> = {};
  for (const nom of noms) {
    if (!nom.ibdbPersonId || nom.name === '(show-level)') continue;
    if (!result[nom.ibdbPersonId]) {
      result[nom.ibdbPersonId] = { nominated: true, won: nom.won, categories: [nom.category] };
    } else {
      if (nom.won) result[nom.ibdbPersonId].won = true;
      result[nom.ibdbPersonId].categories.push(nom.category);
    }
  }
  return result;
}

/**
 * Build leaderboard of people with most Tony nominations/wins.
 * Only includes people (not show-level entries).
 */
export function getTonyLeaderboard(): LeaderboardEntry[] {
  if (leaderboardCache) return leaderboardCache;

  ensurePersonIndex();

  const entries: LeaderboardEntry[] = [];
  for (const [personId, noms] of Array.from(byPersonId!.entries())) {
    const actingNoms = noms.filter((n: TonyNomination) => isActingCategory(n.category));
    const creativeNoms = noms.filter((n: TonyNomination) => !isActingCategory(n.category));
    entries.push({
      name: noms[0].name,
      ibdbPersonId: personId,
      nominations: noms.length,
      wins: noms.filter((n: TonyNomination) => n.won).length,
      actingNominations: actingNoms.length,
      actingWins: actingNoms.filter((n: TonyNomination) => n.won).length,
      categories: Array.from(new Set(noms.map((n: TonyNomination) => n.category))),
      shows: Array.from(new Set(noms.map((n: TonyNomination) => n.showId))),
      actingShowCount: new Set(actingNoms.map((n: TonyNomination) => n.showId)).size,
      creativeShowCount: new Set(creativeNoms.map((n: TonyNomination) => n.showId)).size,
    });
  }

  // Sort: wins desc, then nominations desc
  entries.sort((a, b) => b.wins - a.wins || b.nominations - a.nominations);
  leaderboardCache = entries;
  return entries;
}

/**
 * Get the last-updated date for Tony nominations data
 */
export function getTonyNominationsLastUpdated(): string {
  return data._meta.lastUpdated;
}

/**
 * Get total counts — person-level only (matches what the leaderboard displays).
 * _meta totals include show-level entries (Best Musical/Play/Revival) which
 * are not shown in the person leaderboard.
 */
export function getTonyNominationsMeta() {
  const personNoms = data.nominations.filter(n => n.ibdbPersonId);
  return {
    totalNominations: personNoms.length,
    totalWins: personNoms.filter(n => n.won).length,
    showCount: data._meta.actualShowCount,
    coverage: data._meta.coverage,
  };
}
