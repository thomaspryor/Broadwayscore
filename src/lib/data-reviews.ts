// Outlet & Critic profile data module
// Imports reviews.json + shows.json directly (NOT through engine.ts or data.ts barrel)
// Pages using this module must import it directly to avoid bundle bloat on other routes

import type { ProfileReview, OutletProfile, CriticProfile } from './data-types';
import { OUTLET_TIERS } from '@/config/scoring';
import { OUTLET_LOGOS } from '@/config/outlet-logos';
import { slugify } from './data-core';

import reviewsData from '../../data/reviews.json';
import showsData from '../../data/shows.json';
// Retired critic slugs → canonical (2026 data audit, S5-T9). The same compact
// map src/middleware.ts 301s from; entries originate in
// data/critic-slug-aliases.json (core data) via scripts/build-slug-redirects.js
// at prebuild, so the redirect and this lookup can never disagree.
import slugRedirectsData from '../../data/slug-redirects-compact.json';
import { resolveCriticRedirect, type SlugRedirectMap } from './slug-redirects';

// ============================================
// Normalization maps — merge split outlet profiles
// ============================================

// Critic names carry NO map here. reviews.json `criticName` is already the
// display name — or null when the byline is not a person ("Archive", an
// outlet's own name, "Written by") — because scripts/rebuild-all-reviews.js
// runs scripts/lib/critic-display-name.js displayCriticName() once at
// emission (2026 data audit, S7-T2). The typo table that used to live here
// (CRITIC_NAME_FIXES) is scripts/lib/critic-name-fixes.json, read by that
// helper only; a second map on this side is exactly the drift S7-T1 removed.

// Variant outletIds → canonical outletId (merges split profiles)
const OUTLET_ID_FIXES: Record<string, string> = {
  'newyorkmagazine': 'vulture',
  'vulturecom': 'vulture',
  'the-guardian-uk': 'guardian',
  'ny-post': 'nypost',
  'ny-newsday': 'newsday',
  'entertainment-weekly': 'ew',
  'broadwayworldcom': 'broadwayworld',
  'chicago-tribute': 'chicagotribune',
  'new-york-1': 'ny1',
  'observer-david-cote': 'observer',
  'associated-press': 'ap',
  'associated-press-mark-kennedy': 'ap',
  'amny-matt-windman': 'amny',
  'amnycom': 'amny',
  'am-ny-matt-windman': 'amny',
  'theaterscenecom': 'theater-scene',
  'bloomberg-news': 'bloomberg',
  'newyorktheater': 'nyt-theater',
  'new-york-theatre': 'nytg',
  'new-york-theatre-guide-gillian-russo': 'nytg',
  'financial-times-uk': 'financialtimes',
  'the-stage-uk': 'thestage',
  'the-telegraph-uk': 'telegraph',
  'the-times-uk': 'the-times',
  'the-independent-uk': 'the-independent',
  'the-star-ledger': 'njcom',
  'forward-samuel-eli-shepherd': 'forward',
  '1minutecritic': 'one-minute-critic',
  'oneminutecritic': 'one-minute-critic',
  '1-minute-critic-matthew-wexler': 'one-minute-critic',
  'the-record': 'northjerseycom',
  'the-record-bergen': 'northjerseycom',
  'bergen-record': 'northjerseycom',
  'northjereycom': 'northjerseycom',
  'theatre-news-online': 'theater-news-online',
  'new-city-stage': 'newcity-stage',
  'perezhilton': 'perez-hilton',
  'melindas-malarky': 'melindasmalarky',
  'fort-worth-star-telgram': 'fort-worth-star-telegram',
  'the-faster-times': 'faster-times',
  'the-news-herald': 'news-herald',
  'shelby-star-patrick-ryan': 'usatoday',
  'hollywood-soapbox-john-soltes': 'hollywood-soapbox',
  'nytheatrecom': 'nytheatre',
  'nytheatrereviewcom': 'nytheatre',
  'nytheatre-review': 'nytheatre',
  'philadelpia-inquirer': 'philadelphia-inquirer',
  'philadlephia-inquirer': 'philadelphia-inquirer',
  'vartiey': 'variety',
  'varietycom': 'variety',
  'bloombeg-news': 'bloomberg',
  'bloomberg-jason-zinoman': 'bloomberg',
  'bloomberg-news-jason-zinoman': 'bloomberg',
  'bloomberg-jason-zinoman-1': 'bloomberg',
  'washingtion-post': 'washpost',
  'washinton-post': 'washpost',
  'hollywoodwood-reporter': 'hollywood-reporter',
  'hollywood-reporter-david-rooney': 'hollywood-reporter',
  'villiage-voice': 'village-voice',
  'village-voice-michael-feingold': 'village-voice',
  'village-voice-michael-musto': 'village-voice',
  'theater-news-online-jeremy-gerard': 'theater-news-online',
  'theater-news-online-joe-dziemianowicz': 'theater-news-online',
  'theater-news-online-david-cote': 'theater-news-online',
  'theater-news-online-brian-scott-lipton': 'theater-news-online',
  'theatre-news-online-jeremy-gerard': 'theater-news-online',
  'theatre-news-online-joe-dziemianowicz': 'theater-news-online',
  'theatre-news-online-david-cote': 'theater-news-online',
  'theaternewsonline-joe-dziemianowicz': 'theater-news-online',
  'showbiz411-roger-friedman': 'showbiz411',
  'showbiz411-roger-friedman-1': 'showbiz411',
  'enertainment-weekly': 'ew',
  'entertainmet-weekly': 'ew',
  'thedaily-beast': 'dailybeast',
  'the-daily-beast': 'dailybeast',
  'uk-guardian': 'guardian',
  'the-guardian': 'guardian',
  'guardiancom': 'guardian',
  'new-york-magazine': 'vulture',
  'new-york-magazine-vulture': 'vulture',
  'nymag-vulture': 'vulture',
  'nbcnewyork': 'nbcny',
  'nbc-new-york': 'nbcny',
  'time-out': 'timeout',
  'time-out-new-york': 'timeout',
  'timeout-new-york': 'timeout',
  'new-york-daily-news': 'nydailynews',
  'ny-daily-news': 'nydailynews',
  'wall-street-journal': 'wsj',
  'huffingtonpost': 'huffpost',
  'the-huffington-post': 'huffpost',
  'backsatage': 'backstage',
  'backstage-magazine': 'backstage',
  'the-theatre-times-michael-appler': 'theater-news-online',
  'joe-dziemianowicz': 'theater-news-online',
  'jeremy-gerard': 'theater-news-online',
};

// Garbage outletIds that are review fragments, not real outlets — skip entirely
const GARBAGE_OUTLET_IDS = new Set([
  'is-intense-in-a-way-ive-never-seen-on-broadway',
  'whose-title-is-something-of-a-misnomer',
  'should-appeal-to-two-audiences',
  'keep-things-speeding-along',
  'beetlejuice-beetlejuice',
  'ricky-martin',
]);

// ============================================
// Date parsing — explicit, no raw new Date()
// ============================================

function parseReviewDate(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  // ISO format: 2024-01-15
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    const d = new Date(dateStr + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  // "Month DD, YYYY" format
  const match = dateStr.match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (match) {
    const d = new Date(`${match[1]} ${match[2]}, ${match[3]}`);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  // Fallback
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.getTime();
}

// ============================================
// Build show metadata map (lightweight)
// ============================================

interface ShowMeta {
  id: string;
  title: string;
  slug: string;
  venue: string;
  openingDate: string;
  status: string;
  type: string;
  thumbnail: string | null;
  category: string;
}

const showMetaMap = new Map<string, ShowMeta>();
for (const show of (showsData as { shows: Array<{
  id: string; title: string; slug: string; venue: string;
  openingDate: string; status: string; type: string;
  category?: string;
  images?: { thumbnail?: string };
}> }).shows) {
  showMetaMap.set(show.id, {
    id: show.id,
    title: show.title,
    slug: show.slug,
    venue: show.venue,
    openingDate: show.openingDate,
    status: show.status,
    type: show.type,
    thumbnail: show.images?.thumbnail || null,
    category: show.category || 'broadway',
  });
}

// ============================================
// Tier lookup helper
// ============================================

function getOutletTier(outletId: string): { tier: 1 | 2 | 3 | 4; name: string } {
  const normalized = outletId?.toLowerCase().trim();
  if (normalized && OUTLET_TIERS[normalized]) {
    return { tier: OUTLET_TIERS[normalized].tier, name: OUTLET_TIERS[normalized].name };
  }
  return { tier: 3, name: '' };
}

function getOutletLogo(outletName: string): { domain: string | null; color: string | null; abbrev: string | null } {
  const config = OUTLET_LOGOS[outletName];
  if (!config) return { domain: null, color: null, abbrev: null };
  return { domain: config.domain, color: config.color || null, abbrev: config.abbrev || null };
}

// ============================================
// Build profiles — runs once at import time
// ============================================

interface RawReviewEntry {
  showId: string;
  outletId: string;
  outlet: string;
  /** Display name from displayCriticName() at emission, or null: no person byline. */
  criticName?: string | null;
  url: string;
  publishDate?: string;
  assignedScore: number;
  tier?: number;
  originalRating?: string;
  pullQuote?: string;
  /** Set when the rebuild copied this review onto a returning production's entry from its
   *  earlier run (BRO-4759). The original row stays on the earlier entry. */
  inheritedFromShowId?: string;
}

// ============================================
// Critic grouping — pure, so tests/unit/data-reviews-critic-grouping.test.ts
// can require() the real rule (CLAUDE.md §15)
// ============================================

/**
 * The critic-page identity of an emitted byline: its URL slug, or null when
 * the review gets no critic page. reviews.json carries null for a byline
 * that is not a person (S7-T2), and that null is the only signal this side
 * honours — no name map, no placeholder list. "Unknown" is the pre-S7-T2
 * sentinel the emitter no longer writes; still excluded so a reviews.json
 * built before the emitter change cannot mint /critics/unknown.
 *
 * Keying on the slug (not the string) is what makes the diacritic fold
 * (S7-T3) safe: displayCriticName() keeps each byline's own spelling, so
 * "Juan A. Ramírez" and "Juan A. Ramirez" both reach here and must land on
 * ONE page at /critics/juan-a-ramirez, not on a page plus a collision-suffixed
 * twin. Two different people who share a name already shared a page before
 * this rule (exact-string grouping), so it merges nothing new but spelling.
 */
export function criticProfileKey(criticName: string | null | undefined): string | null {
  if (typeof criticName !== 'string') return null;
  const name = criticName.trim();
  if (!name || name === 'Unknown') return null;
  return slugify(name) || null;
}

export interface CriticGroup<T> {
  /** URL slug — the group key. */
  slug: string;
  /** Display name: the spelling most reviews carry; ties keep diacritics, then the longer, then the earlier alphabetically. */
  name: string;
  reviews: T[];
}

function nonAsciiCount(s: string): number {
  let n = 0;
  for (const ch of s) if (ch.charCodeAt(0) > 0x7f) n++;
  return n;
}

/** The spelling a critic page is titled with, from spelling → review count. */
export function pickCriticDisplayName(spellings: ReadonlyMap<string, number>): string {
  let best: string | null = null;
  let bestCount = -1;
  for (const [spelling, count] of Array.from(spellings.entries())) {
    if (best === null || count > bestCount) {
      best = spelling;
      bestCount = count;
      continue;
    }
    if (count < bestCount) continue;
    const better =
      nonAsciiCount(spelling) > nonAsciiCount(best) ||
      (nonAsciiCount(spelling) === nonAsciiCount(best) &&
        (spelling.length > best.length || (spelling.length === best.length && spelling < best)));
    if (better) best = spelling;
  }
  return best ?? '';
}

/**
 * Group reviews into critic pages. Reviews whose criticProfileKey() is null
 * (no byline) are left out; groups keep first-seen order, reviews keep input
 * order. Every spelling in a group is listed in `spellings` so callers can
 * map a byline back to its page.
 */
export function groupReviewsByCritic<T extends { criticName: string | null }>(
  reviews: readonly T[]
): Array<CriticGroup<T> & { spellings: Map<string, number> }> {
  const groups = new Map<string, { reviews: T[]; spellings: Map<string, number> }>();
  for (const review of reviews) {
    const slug = criticProfileKey(review.criticName);
    if (!slug) continue;
    const spelling = (review.criticName as string).trim();
    let group = groups.get(slug);
    if (!group) {
      group = { reviews: [], spellings: new Map() };
      groups.set(slug, group);
    }
    group.reviews.push(review);
    group.spellings.set(spelling, (group.spellings.get(spelling) || 0) + 1);
  }
  return Array.from(groups.entries()).map(([slug, g]) => ({
    slug,
    name: pickCriticDisplayName(g.spellings),
    reviews: g.reviews,
    spellings: g.spellings,
  }));
}

// Accumulation maps
const outletReviewsMap = new Map<string, ProfileReview[]>();
const allProfileReviews: ProfileReview[] = [];

const reviews = (reviewsData as { reviews: RawReviewEntry[] }).reviews;

/**
 * A review the rebuild copied onto a returning production's entry from its earlier run is the
 * same article as the row on the earlier entry. Critic and outlet profiles count each article
 * once, so they skip the copy (the show page and its score keep it).
 */
export function isInheritedReview(review: { inheritedFromShowId?: string | null }): boolean {
  return !!review.inheritedFromShowId;
}

for (const review of reviews) {
  if (isInheritedReview(review)) continue;
  const show = showMetaMap.get(review.showId);
  if (!show) continue;
  // Include Broadway, Off-Broadway, West End, and Off-West End reviews on critic/outlet pages.
  // The critic page UI defaults to Broadway (or West End for UK critics) and exposes
  // an Off-Broadway / Off-West End pill when the critic has enough coverage in that market.
  if (show.category !== 'broadway' && show.category !== 'off-broadway' && show.category !== 'west-end' && show.category !== 'off-west-end') continue;

  // Normalize outletId — skip garbage entries
  const rawOutletId = review.outletId;
  if (GARBAGE_OUTLET_IDS.has(rawOutletId)) continue;
  const outletId = OUTLET_ID_FIXES[rawOutletId] || rawOutletId;

  // The emitted display name, as is (see the note above the outlet map).
  const criticName = typeof review.criticName === 'string' && review.criticName.trim() ? review.criticName.trim() : null;

  const tierInfo = getOutletTier(outletId);
  const parsedDate = parseReviewDate(review.publishDate);

  const profileReview: ProfileReview = {
    showTitle: show.title,
    showSlug: show.slug,
    showThumbnail: show.thumbnail,
    showVenue: show.venue,
    showOpeningDate: show.openingDate,
    showStatus: show.status,
    showType: show.type,
    showCategory: show.category,
    outletId,
    outlet: review.outlet,
    outletSlug: '', // filled in after outlet profiles built
    criticName,
    criticSlug: null, // filled in after critic profiles built
    url: review.url,
    publishDate: review.publishDate || null,
    parsedDate,
    reviewScore: review.assignedScore,
    tier: tierInfo.tier,
    originalRating: review.originalRating || null,
    quote: review.pullQuote || null,
  };

  // Group by outletId (canonical)
  const outletKey = outletId;
  if (!outletReviewsMap.has(outletKey)) outletReviewsMap.set(outletKey, []);
  outletReviewsMap.get(outletKey)!.push(profileReview);

  // Critic grouping happens below over this list (groupReviewsByCritic).
  allProfileReviews.push(profileReview);
}

// ============================================
// Compute stats helper
// ============================================

function computeStats(reviews: ProfileReview[]): { avg: number; high: number; low: number } {
  if (reviews.length === 0) return { avg: 0, high: 0, low: 0 };
  let sum = 0, high = -Infinity, low = Infinity;
  for (const r of reviews) {
    sum += r.reviewScore;
    if (r.reviewScore > high) high = r.reviewScore;
    if (r.reviewScore < low) low = r.reviewScore;
  }
  return { avg: Math.round(sum / reviews.length), high, low };
}

// ============================================
// Build Outlet Profiles
// ============================================

const outletSlugMap = new Map<string, OutletProfile>();

const outletProfilesList: OutletProfile[] = [];
for (const [outletId, reviews] of Array.from(outletReviewsMap.entries())) {
  // Determine display name: prefer OUTLET_TIERS name, fallback to most common name in reviews
  const tierInfo = getOutletTier(outletId);
  let displayName = tierInfo.name;
  if (!displayName) {
    // Use the most common outlet name across this outlet's reviews
    const nameCounts = new Map<string, number>();
    for (const r of reviews) {
      nameCounts.set(r.outlet, (nameCounts.get(r.outlet) || 0) + 1);
    }
    displayName = Array.from(nameCounts.entries()).sort((a, b) => b[1] - a[1])[0][0];
  }

  const stats = computeStats(reviews);
  const logo = getOutletLogo(displayName);

  // Count unique critics (by page identity, so spelling variants count once; no byline → not a critic)
  const uniqueCritics = new Set(reviews.map(r => criticProfileKey(r.criticName)).filter(Boolean));

  // Generate slug — collision handled below
  let slug = slugify(displayName);

  const profile: OutletProfile = {
    name: displayName,
    slug,
    outletId,
    tier: tierInfo.tier,
    reviews,
    reviewCount: reviews.length,
    avgScore: stats.avg,
    highScore: stats.high,
    lowScore: stats.low,
    volumeRank: 0,  // computed after all profiles built
    generosityRank: 0,
    criticCount: uniqueCritics.size,
    logoDomain: logo.domain,
    logoColor: logo.color,
    logoAbbrev: logo.abbrev,
  };

  // Handle slug collision
  if (outletSlugMap.has(slug)) {
    slug = `${slug}-${outletId}`;
    profile.slug = slug;
  }
  outletSlugMap.set(slug, profile);
  outletProfilesList.push(profile);
}

// Sort by review count desc and assign ranks
outletProfilesList.sort((a, b) => b.reviewCount - a.reviewCount);
outletProfilesList.forEach((p, i) => { p.volumeRank = i + 1; });

// Generosity rank (by avg score desc)
const outletsByGenerosity = [...outletProfilesList].sort((a, b) => b.avgScore - a.avgScore);
outletsByGenerosity.forEach((p, i) => { p.generosityRank = i + 1; });

// ============================================
// Build Critic Profiles
// ============================================

const criticSlugMap = new Map<string, CriticProfile>();
// Every spelling a page's reviews carry → that page's slug (back-fills criticSlug below).
const criticNameToSlug = new Map<string, string>();

const criticProfilesList: CriticProfile[] = [];
for (const group of groupReviewsByCritic(allProfileReviews)) {
  const { slug, name: criticName, reviews } = group;
  const stats = computeStats(reviews);

  // Outlets in first-seen order with review counts and most recent review date.
  const outletCounts = new Map<string, number>();
  const recencyMap = new Map<string, number>();
  for (const r of reviews) {
    outletCounts.set(r.outlet, (outletCounts.get(r.outlet) || 0) + 1);
    if (r.parsedDate && (!recencyMap.has(r.outlet) || r.parsedDate > recencyMap.get(r.outlet)!)) {
      recencyMap.set(r.outlet, r.parsedDate);
    }
  }

  // Determine primary outlet (most reviews)
  let primaryOutlet = '';
  let primaryOutletId = '';
  let maxCount = 0;
  for (const [outletName, count] of Array.from(outletCounts.entries())) {
    if (count > maxCount) {
      maxCount = count;
      primaryOutlet = outletName;
      // Find the outletId from the reviews
      const matchingReview = reviews.find(r => r.outlet === outletName);
      primaryOutletId = matchingReview?.outletId || '';
    }
  }

  // Sort outlets by most recent review date (descending)
  const outlets = Array.from(outletCounts.keys());
  outlets.sort((a, b) => (recencyMap.get(b) || 0) - (recencyMap.get(a) || 0));
  const isFreelancer = outlets.length >= 3;

  // The slug IS the group key, so two pages can never collide here — the
  // outlet-suffixed twins the old exact-string grouping minted for spelling
  // variants ("holly-o-mahony-the-stage") are gone by construction.
  const profile: CriticProfile = {
    name: criticName,
    slug,
    primaryOutlet,
    primaryOutletId,
    outlets,
    isFreelancer,
    reviews,
    reviewCount: reviews.length,
    avgScore: stats.avg,
    highScore: stats.high,
    lowScore: stats.low,
    volumeRank: 0,
    generosityRank: 0,
  };

  criticSlugMap.set(slug, profile);
  criticProfilesList.push(profile);
  for (const spelling of Array.from(group.spellings.keys())) criticNameToSlug.set(spelling, slug);
}

// Sort by review count desc and assign ranks
criticProfilesList.sort((a, b) => b.reviewCount - a.reviewCount);
criticProfilesList.forEach((p, i) => { p.volumeRank = i + 1; });

// Generosity rank
const criticsByGenerosity = [...criticProfilesList].sort((a, b) => b.avgScore - a.avgScore);
criticsByGenerosity.forEach((p, i) => { p.generosityRank = i + 1; });

// ============================================
// Back-fill outletSlug and criticSlug on reviews
// ============================================

// Build outletId → slug lookup from outlet profiles
const outletIdToSlug = new Map<string, string>();
for (const outlet of outletProfilesList) {
  outletIdToSlug.set(outlet.outletId, outlet.slug);
}

// Fill in slugs on all reviews (shared objects, so both outlet and critic profile reviews updated)
for (const reviews of Array.from(outletReviewsMap.values())) {
  for (const r of reviews) {
    r.outletSlug = outletIdToSlug.get(r.outletId) || slugify(r.outlet);
    if (r.criticName) {
      r.criticSlug = criticNameToSlug.get(r.criticName) || null;
    }
  }
}

// ============================================
// Exported functions
// ============================================

export function getAllOutlets(): OutletProfile[] {
  return outletProfilesList;
}

export function getOutletBySlug(slug: string): OutletProfile | undefined {
  return outletSlugMap.get(slug);
}

export function getAllOutletSlugs(): string[] {
  return Array.from(outletSlugMap.keys());
}

export function getAllCritics(): CriticProfile[] {
  return criticProfilesList;
}

const criticRedirectMap: SlugRedirectMap = slugRedirectsData as Record<string, string>;

/**
 * @param redirects the compact redirect map — tests only; production callers
 *   always resolve through the tracked data/slug-redirects-compact.json.
 */
export function getCriticBySlug(slug: string, redirects: SlugRedirectMap = criticRedirectMap): CriticProfile | undefined {
  const exact = criticSlugMap.get(slug);
  if (exact) return exact;
  // Old slug (diacritic-mangled, merged spelling) → the canonical profile.
  // Requests normally never get here — the middleware 301s first — but any
  // caller holding an old slug (or a runtime without the middleware) still
  // resolves the same critic instead of a 404.
  const canonical = resolveCriticRedirect(redirects, slug);
  return canonical ? criticSlugMap.get(canonical) : undefined;
}

export function getAllCriticSlugs(): string[] {
  return Array.from(criticSlugMap.keys());
}

export function getOutletSlugById(outletId: string): string | null {
  return outletIdToSlug.get(outletId) || null;
}

export function getCriticSlugByName(name: string): string | null {
  const known = criticNameToSlug.get(name);
  if (known) return known;
  // A spelling this build has not seen on a critic-page review (e.g. a
  // show-page byline outside the four profiled markets) still links when its
  // page identity exists.
  const key = criticProfileKey(name);
  return key && criticSlugMap.has(key) ? key : null;
}
