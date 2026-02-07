// Gold Lists data computation module
// Imports: shows.json, reviews.json, audience-buzz.json, grosses.json, grosses-history.json
// HEAVY — only imported by Gold List pages, NEVER by show pages
// Show pages use data-gold-list-badges.ts (lightweight, ~50KB) instead

import type { GoldListEntry } from './data-types';
import type { GoldListType } from '@/config/gold-lists';
import { GOLD_LIST_MAP } from '@/config/gold-lists';
import { OUTLET_TIERS, TIER_WEIGHTS, DEFAULT_TIER } from '@/config/scoring';
import { toScoringId } from './outlet-id-mapper';
import { getSeason } from './data-commercial';

import showsData from '../../data/shows.json';
import reviewsData from '../../data/reviews.json';
import audienceBuzzData from '../../data/audience-buzz.json';
import grossesData from '../../data/grosses.json';
import grossesHistoryData from '../../data/grosses-history.json';

// ============================================
// Internal types for JSON data
// ============================================

interface RawShowData {
  id: string;
  title: string;
  slug: string;
  venue: string;
  openingDate: string;
  type: string;
}

interface RawReviewData {
  showId: string;
  outletId: string;
  assignedScore: number | null;
}

interface AudienceBuzzFile {
  shows: Record<string, {
    combinedScore: number | null;
    designation: string | null;
    sources: Record<string, unknown>;
  }>;
}

interface GrossesFile {
  shows: Record<string, {
    allTime: {
      gross: number | null;
      performances: number | null;
      attendance: number | null;
    };
  }>;
}

interface GrossesHistoryFile {
  _meta: { lastUpdated: string };
  weeks: Record<string, Record<string, {
    gross: number | null;
    capacity: number | null;
    atp: number | null;
    attendance: number | null;
    performances: number | null;
  }>>;
}

// ============================================
// Data setup
// ============================================

const shows = (showsData as { shows: RawShowData[] }).shows;
const showById = new Map(shows.map(s => [s.id, s]));
const showBySlug = new Map(shows.map(s => [s.slug, s]));
const allReviews = Object.values(
  (reviewsData as unknown as { reviews: Record<string, RawReviewData> }).reviews
);
const audienceBuzz = audienceBuzzData as unknown as AudienceBuzzFile;
const grosses = grossesData as unknown as GrossesFile;
const grossesHistory = grossesHistoryData as unknown as GrossesHistoryFile;

// ============================================
// Tier weight helper (uses actual scoring.ts config)
// ============================================

function getTierWeight(outletId: string): number {
  const scoringId = toScoringId(outletId);
  if (scoringId && OUTLET_TIERS[scoringId]) {
    const tier = OUTLET_TIERS[scoringId].tier;
    return TIER_WEIGHTS[tier];
  }
  return TIER_WEIGHTS[DEFAULT_TIER];
}

// ============================================
// Season discovery
// ============================================

/** Get all seasons that have shows */
export function getSeasonsWithData(): string[] {
  const seasons = new Set<string>();
  for (const show of shows) {
    const season = getSeason(show.openingDate);
    if (season) seasons.add(season);
  }
  return Array.from(seasons).sort().reverse();
}

/** Check if a season is the current one */
export function isCurrentSeason(season: string): boolean {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const currentSeason = month >= 6 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
  return season === currentSeason;
}

// ============================================
// 1. CRITICAL GOLD LIST
// ============================================

function computeCriticalGold(season: string): GoldListEntry[] {
  const config = GOLD_LIST_MAP['critical-gold'];

  // Group reviews by showId
  const byShow = new Map<string, RawReviewData[]>();
  for (const review of allReviews) {
    if (!review.showId || review.assignedScore == null) continue;
    const existing = byShow.get(review.showId) || [];
    existing.push(review);
    byShow.set(review.showId, existing);
  }

  const results: GoldListEntry[] = [];

  for (const [showId, reviews] of Array.from(byShow.entries())) {
    const show = showById.get(showId);
    if (!show || getSeason(show.openingDate) !== season) continue;
    if (reviews.length < 5) continue;

    let weightedSum = 0;
    let weightSum = 0;
    for (const r of reviews) {
      if (r.assignedScore == null) continue;
      const w = getTierWeight(r.outletId);
      weightedSum += r.assignedScore * w;
      weightSum += w;
    }

    if (weightSum === 0) continue;
    const score = weightedSum / weightSum;
    if (score < config.threshold) continue;

    const rounded = Math.round(score * 10) / 10;
    results.push({
      showId: show.id,
      title: show.title,
      slug: show.slug,
      rank: 0, // set after sorting
      value: rounded,
      displayValue: rounded.toFixed(1),
      season,
      venue: show.venue,
      type: show.type,
    });
  }

  results.sort((a, b) => b.value - a.value);
  return results.slice(0, config.maxPerSeason).map((entry, i) => ({
    ...entry,
    rank: i + 1,
  }));
}

// ============================================
// 2. AUDIENCE GOLD LIST
// ============================================

function computeAudienceGold(season: string): GoldListEntry[] {
  const config = GOLD_LIST_MAP['audience-gold'];
  const abShows = audienceBuzz.shows || {};
  const results: GoldListEntry[] = [];

  for (const [showId, data] of Object.entries(abShows)) {
    const show = showById.get(showId);
    if (!show || getSeason(show.openingDate) !== season) continue;
    if (data.combinedScore == null || data.combinedScore < config.threshold) continue;

    results.push({
      showId: show.id,
      title: show.title,
      slug: show.slug,
      rank: 0,
      value: data.combinedScore,
      displayValue: String(data.combinedScore),
      season,
      venue: show.venue,
      type: show.type,
    });
  }

  results.sort((a, b) => b.value - a.value);
  return results.slice(0, config.maxPerSeason).map((entry, i) => ({
    ...entry,
    rank: i + 1,
  }));
}

// ============================================
// 3. BOX OFFICE GOLD LIST
// ============================================

function computeBoxOfficeGold(season: string): GoldListEntry[] {
  const config = GOLD_LIST_MAP['box-office-gold'];
  const showGrosses = grosses.shows || {};
  const results: GoldListEntry[] = [];

  for (const [slug, data] of Object.entries(showGrosses)) {
    const show = showBySlug.get(slug);
    if (!show || getSeason(show.openingDate) !== season) continue;

    const allTime = data.allTime;
    if (!allTime || !allTime.performances || allTime.performances < 50) continue;
    if (!allTime.gross || allTime.gross <= 0) continue;

    const grossPerPerf = allTime.gross / allTime.performances;

    results.push({
      showId: show.id,
      title: show.title,
      slug: show.slug,
      rank: 0,
      value: Math.round(grossPerPerf),
      displayValue: '$' + Math.round(grossPerPerf).toLocaleString('en-US'),
      season,
      venue: show.venue,
      type: show.type,
    });
  }

  results.sort((a, b) => b.value - a.value);
  return results.slice(0, config.maxPerSeason).map((entry, i) => ({
    ...entry,
    rank: i + 1,
  }));
}

// ============================================
// 4. HOT TICKET GOLD LIST
// ============================================

/** Check if a season has enough grosses-history data for Hot Ticket */
export function hasHotTicketData(season: string): boolean {
  const weeks = grossesHistory.weeks || {};
  const weekDates = Object.keys(weeks).sort();
  if (weekDates.length === 0) return false;

  const [startYear] = season.split('-');
  const seasonStartDate = `${startYear}-07-01`;
  const seasonEndDate = `${parseInt(startYear) + 1}-06-30`;
  const seasonWeeks = weekDates.filter(d => d >= seasonStartDate && d <= seasonEndDate);

  return seasonWeeks.length >= 4;
}

function computeHotTicketGold(season: string): GoldListEntry[] {
  const config = GOLD_LIST_MAP['hot-ticket-gold'];
  const weeks = grossesHistory.weeks || {};
  const weekDates = Object.keys(weeks).sort();

  if (weekDates.length === 0) return [];

  const [startYear] = season.split('-');
  const seasonStartDate = `${startYear}-07-01`;
  const seasonEndDate = `${parseInt(startYear) + 1}-06-30`;
  const seasonWeeks = weekDates.filter(d => d >= seasonStartDate && d <= seasonEndDate);

  if (seasonWeeks.length < 4) return [];

  // Collect capacity data per show
  const showCapacity = new Map<string, number[]>();
  for (const weekDate of seasonWeeks) {
    const weekData = weeks[weekDate];
    for (const [slug, data] of Object.entries(weekData)) {
      if (data.capacity == null) continue;
      const existing = showCapacity.get(slug) || [];
      existing.push(data.capacity);
      showCapacity.set(slug, existing);
    }
  }

  const results: GoldListEntry[] = [];
  for (const [slug, capacities] of Array.from(showCapacity.entries())) {
    if (capacities.length < 8) continue;

    const show = showBySlug.get(slug);
    if (!show || getSeason(show.openingDate) !== season) continue;

    const avgCapacity = capacities.reduce((a: number, b: number) => a + b, 0) / capacities.length;
    if (avgCapacity < config.threshold) continue;

    const rounded = Math.round(avgCapacity * 10) / 10;
    results.push({
      showId: show.id,
      title: show.title,
      slug: show.slug,
      rank: 0,
      value: rounded,
      displayValue: rounded.toFixed(1) + '%',
      season,
      venue: show.venue,
      type: show.type,
    });
  }

  results.sort((a, b) => b.value - a.value);
  return results.slice(0, config.maxPerSeason).map((entry, i) => ({
    ...entry,
    rank: i + 1,
  }));
}

// ============================================
// Public API
// ============================================

const listComputeFns: Record<GoldListType, (season: string) => GoldListEntry[]> = {
  'critical-gold': computeCriticalGold,
  'audience-gold': computeAudienceGold,
  'box-office-gold': computeBoxOfficeGold,
  'hot-ticket-gold': computeHotTicketGold,
};

/** Get a Gold List for a specific type and season */
export function getGoldList(type: GoldListType, season: string): GoldListEntry[] {
  const fn = listComputeFns[type];
  if (!fn) return [];
  return fn(season);
}

/** Get an all-time Gold List (top N across all seasons since 2005) */
export function getAllTimeGoldList(type: GoldListType): GoldListEntry[] {
  const config = GOLD_LIST_MAP[type];
  if (!config) return [];

  const allSeasons = getSeasonsWithData();
  const allEntries: GoldListEntry[] = [];

  for (const season of allSeasons) {
    // For all-time, gather ALL qualifying entries (not capped per season)
    const fn = listComputeFns[type];
    if (!fn) continue;

    // Temporarily compute without per-season cap
    const entries = computeAllQualifying(type, season);
    allEntries.push(...entries);
  }

  // Sort and take top N
  allEntries.sort((a, b) => b.value - a.value);
  return allEntries.slice(0, config.maxAllTime).map((entry, i) => ({
    ...entry,
    rank: i + 1,
  }));
}

/** Compute all qualifying entries for a season (no per-season cap) — used for all-time lists */
function computeAllQualifying(type: GoldListType, season: string): GoldListEntry[] {
  const config = GOLD_LIST_MAP[type];
  if (!config) return [];

  // Re-use the same logic but without the slice
  const fn = listComputeFns[type];
  if (!fn) return [];

  // We need uncapped results — compute directly
  switch (type) {
    case 'critical-gold': return computeCriticalGoldUncapped(season);
    case 'audience-gold': return computeAudienceGoldUncapped(season);
    case 'box-office-gold': return computeBoxOfficeGoldUncapped(season);
    case 'hot-ticket-gold': return computeHotTicketGoldUncapped(season);
    default: return [];
  }
}

// Uncapped versions for all-time computation
function computeCriticalGoldUncapped(season: string): GoldListEntry[] {
  const config = GOLD_LIST_MAP['critical-gold'];
  const byShow = new Map<string, RawReviewData[]>();
  for (const review of allReviews) {
    if (!review.showId || review.assignedScore == null) continue;
    const existing = byShow.get(review.showId) || [];
    existing.push(review);
    byShow.set(review.showId, existing);
  }

  const results: GoldListEntry[] = [];
  for (const [showId, reviews] of Array.from(byShow.entries())) {
    const show = showById.get(showId);
    if (!show || getSeason(show.openingDate) !== season) continue;
    if (reviews.length < 5) continue;

    let weightedSum = 0, weightSum = 0;
    for (const r of reviews) {
      if (r.assignedScore == null) continue;
      const w = getTierWeight(r.outletId);
      weightedSum += r.assignedScore * w;
      weightSum += w;
    }
    if (weightSum === 0) continue;
    const score = weightedSum / weightSum;
    if (score < config.threshold) continue;

    const rounded = Math.round(score * 10) / 10;
    results.push({
      showId: show.id, title: show.title, slug: show.slug,
      rank: 0, value: rounded, displayValue: rounded.toFixed(1),
      season, venue: show.venue, type: show.type,
    });
  }
  return results.sort((a, b) => b.value - a.value);
}

function computeAudienceGoldUncapped(season: string): GoldListEntry[] {
  const config = GOLD_LIST_MAP['audience-gold'];
  const abShows = audienceBuzz.shows || {};
  const results: GoldListEntry[] = [];

  for (const [showId, data] of Object.entries(abShows)) {
    const show = showById.get(showId);
    if (!show || getSeason(show.openingDate) !== season) continue;
    if (data.combinedScore == null || data.combinedScore < config.threshold) continue;

    results.push({
      showId: show.id, title: show.title, slug: show.slug,
      rank: 0, value: data.combinedScore, displayValue: String(data.combinedScore),
      season, venue: show.venue, type: show.type,
    });
  }
  return results.sort((a, b) => b.value - a.value);
}

function computeBoxOfficeGoldUncapped(season: string): GoldListEntry[] {
  const showGrosses = grosses.shows || {};
  const results: GoldListEntry[] = [];

  for (const [slug, data] of Object.entries(showGrosses)) {
    const show = showBySlug.get(slug);
    if (!show || getSeason(show.openingDate) !== season) continue;
    const allTime = data.allTime;
    if (!allTime || !allTime.performances || allTime.performances < 50) continue;
    if (!allTime.gross || allTime.gross <= 0) continue;

    const grossPerPerf = allTime.gross / allTime.performances;
    results.push({
      showId: show.id, title: show.title, slug: show.slug,
      rank: 0, value: Math.round(grossPerPerf),
      displayValue: '$' + Math.round(grossPerPerf).toLocaleString('en-US'),
      season, venue: show.venue, type: show.type,
    });
  }
  return results.sort((a, b) => b.value - a.value);
}

function computeHotTicketGoldUncapped(season: string): GoldListEntry[] {
  const config = GOLD_LIST_MAP['hot-ticket-gold'];
  const weeks = grossesHistory.weeks || {};
  const weekDates = Object.keys(weeks).sort();
  if (weekDates.length === 0) return [];

  const [startYear] = season.split('-');
  const seasonStartDate = `${startYear}-07-01`;
  const seasonEndDate = `${parseInt(startYear) + 1}-06-30`;
  const seasonWeeks = weekDates.filter(d => d >= seasonStartDate && d <= seasonEndDate);
  if (seasonWeeks.length < 4) return [];

  const showCapacity = new Map<string, number[]>();
  for (const weekDate of seasonWeeks) {
    const weekData = weeks[weekDate];
    for (const [slug, data] of Object.entries(weekData)) {
      if (data.capacity == null) continue;
      const existing = showCapacity.get(slug) || [];
      existing.push(data.capacity);
      showCapacity.set(slug, existing);
    }
  }

  const results: GoldListEntry[] = [];
  for (const [slug, capacities] of Array.from(showCapacity.entries())) {
    if (capacities.length < 8) continue;
    const show = showBySlug.get(slug);
    if (!show || getSeason(show.openingDate) !== season) continue;

    const avgCapacity = capacities.reduce((a: number, b: number) => a + b, 0) / capacities.length;
    if (avgCapacity < config.threshold) continue;

    const rounded = Math.round(avgCapacity * 10) / 10;
    results.push({
      showId: show.id, title: show.title, slug: show.slug,
      rank: 0, value: rounded, displayValue: rounded.toFixed(1) + '%',
      season, venue: show.venue, type: show.type,
    });
  }
  return results.sort((a, b) => b.value - a.value);
}

/** Get seasons that have data for a specific list type */
export function getSeasonsForListType(type: GoldListType): string[] {
  if (type === 'hot-ticket-gold') {
    return getSeasonsWithData().filter(s => hasHotTicketData(s));
  }
  // All other list types work for any season with shows
  return getSeasonsWithData();
}
