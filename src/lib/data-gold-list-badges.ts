// Gold List Badges — Lightweight accessor for show pages
// Imports ONLY gold-lists-computed.json (~300KB) — NO reviews.json, grosses-history.json
// Use this on show pages to check if a show is on any Gold List

import type { GoldListMembership } from './data-types';
import type { GoldListType } from '@/config/gold-lists';
import computedData from '../../data/gold-lists-computed.json';

export interface ComputedGoldListEntry {
  showId: string; title: string; slug: string; rank: number;
  value: number; displayValue: string; season: string;
  venue?: string; type?: string; thumbnail?: string | null;
  openingDate?: string | null; closingDate?: string | null;
  status?: string | null; isRevival?: boolean;
}

interface ComputedGoldLists {
  _meta: { lastComputed: string; version: string };
  seasons: string[];
  lists: Record<string, Record<string, ComputedGoldListEntry[]>>;
  memberships: Record<string, Array<{
    listType: string; season: string; rank: number;
  }>>;
}

const data = computedData as unknown as ComputedGoldLists;

/** Get all Gold List memberships for a show (by showId) */
export function getShowGoldListMemberships(showId: string): GoldListMembership[] {
  const memberships = data.memberships[showId];
  if (!memberships) return [];
  return memberships as GoldListMembership[];
}

/** Get season-only memberships (exclude all-time) */
export function getShowSeasonGoldLists(showId: string): GoldListMembership[] {
  return getShowGoldListMemberships(showId).filter(m => m.season !== 'all-time');
}

/** Check if a show is on any Gold List */
export function isOnGoldList(showId: string): boolean {
  return (data.memberships[showId]?.length ?? 0) > 0;
}

/** Get all seasons that have Gold List data */
export function getGoldListSeasons(): string[] {
  return data.seasons;
}

/** Get a Gold List for a specific type and season (from pre-computed data) */
export function getComputedGoldList(listType: string, season: string): ComputedGoldListEntry[] {
  return data.lists[listType]?.[season] || [];
}

/** Get all seasons that have data for a specific list type */
export function getSeasonsForList(listType: string): string[] {
  const listData = data.lists[listType];
  if (!listData) return [];
  return Object.keys(listData).filter(s => s !== 'all-time').sort().reverse();
}

/** Check if current season */
export function isCurrentSeason(season: string): boolean {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const currentSeason = month >= 6 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
  return season === currentSeason;
}
