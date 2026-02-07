// Gold List Badges — Lightweight accessor for show pages
// Imports ONLY gold-lists-computed.json (~300KB) — NO reviews.json, grosses-history.json
// Use this on show pages to check if a show is on any Gold List

import type { GoldListMembership } from './data-types';
import type { GoldListType } from '@/config/gold-lists';
import computedData from '../../data/gold-lists-computed.json';

interface ComputedGoldLists {
  _meta: { lastComputed: string; version: string };
  seasons: string[];
  lists: Record<string, Record<string, Array<{
    showId: string; title: string; slug: string; rank: number;
    value: number; displayValue: string; season: string;
    venue?: string; type?: string;
  }>>>;
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
