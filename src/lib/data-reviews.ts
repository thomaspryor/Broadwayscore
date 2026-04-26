// Outlet & Critic profile data module
// Imports reviews.json + shows.json directly (NOT through engine.ts or data.ts barrel)
// Pages using this module must import it directly to avoid bundle bloat on other routes

import type { ProfileReview, OutletProfile, CriticProfile } from './data-types';
import { OUTLET_TIERS } from '@/config/scoring';
import { OUTLET_LOGOS } from '@/config/outlet-logos';
import { slugify } from './data-core';

import reviewsData from '../../data/reviews.json';
import showsData from '../../data/shows.json';

// ============================================
// Normalization maps — merge typo duplicates
// ============================================

// Critic name typos → canonical name (case-sensitive keys matching reviews.json)
const CRITIC_NAME_FIXES: Record<string, string> = {
  'Ben Brantly': 'Ben Brantley',
  'Ben Branley': 'Ben Brantley',
  'Ben Brantley (Pt. 2)': 'Ben Brantley',
  'Aramide Timubu': 'Aramide Tinubu',
  'Thom Geir': 'Thom Geier',
  'Thom Geler': 'Thom Geier',
  'Thom Greier': 'Thom Geier',
  'Franck Scheck': 'Frank Scheck',
  'Frank Sheck': 'Frank Scheck',
  'Jonny Oleksinski': 'Johnny Oleksinski',
  'Hinton Als': 'Hilton Als',
  'Sarah Holdren': 'Sara Holdren',
  'Linda Winder': 'Linda Winer',
  'Robert Holfer': 'Robert Hofler',
  'Jonathan Mandrell': 'Jonathan Mandell',
  'Elyse Gardner': 'Elysa Gardner',
  'Brain Scott Lipton': 'Brian Scott Lipton',
  'Brian Lipton': 'Brian Scott Lipton',
  'Scott Lipton': 'Brian Scott Lipton',
  'Lea Greenblatt': 'Leah Greenblatt',
  'Lovia Gyarke': 'Lovia Gyarkye',
  'Barbara Shuler': 'Barbara Schuler',
  'Charles McNUlty': 'Charles McNulty',
  'Marilyn Stasio.': 'Marilyn Stasio',
  'Marilyn Stasio (Pt. 2)': 'Marilyn Stasio',
  'Michal Feingold': 'Michael Feingold',
  'Suzt Evans': 'Suzy Evans',
  'Adam Markavitz': 'Adam Markovitz',
  'Diana Snyder': 'Diane Snyder',
  'A. D. Amorosi': 'A.D. Amorosi',
  'Rob Weinert- Kendt': 'Rob Weinert-Kendt',
  'Elizabeth Vincentelli': 'Elisabeth Vincentelli',
  'Steve Suskin': 'Steven Suskin',
  'Daniel D&#8217;Addario': "Daniel D'Addario",
  'CSA.     Naveen Kumar': 'Naveen Kumar',
  'Reviews Karen Galindo': 'Karen Galindo',
  'Michael Glitz': 'Michael Giltz',
  // 'Nancy Sasso Janis' is the correct byline (Patch.com); was previously remapped
  // to 'Sasso Janis' which is wrong. Removed 2026-04-11 after /ship-check audit.
};

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

function getOutletTier(outletId: string): { tier: 1 | 2 | 3; name: string } {
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
  criticName?: string;
  url: string;
  publishDate?: string;
  assignedScore: number;
  tier?: number;
  originalRating?: string;
  pullQuote?: string;
}

// Accumulation maps
const outletReviewsMap = new Map<string, ProfileReview[]>();
const criticReviewsMap = new Map<string, ProfileReview[]>();
// Track critic name → outlets for freelancer detection and primary outlet
const criticOutletsMap = new Map<string, Map<string, number>>(); // criticName → Map<outletName, count>
const criticOutletRecencyMap = new Map<string, Map<string, number>>(); // criticName → Map<outletName, latestParsedDate>

const reviews = (reviewsData as { reviews: RawReviewEntry[] }).reviews;

for (const review of reviews) {
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

  // Normalize critic name
  const rawCriticName = review.criticName;
  const criticName = rawCriticName ? (CRITIC_NAME_FIXES[rawCriticName] || rawCriticName) : null;

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

  // Group by critic (exclude Unknown)
  if (criticName && criticName !== 'Unknown') {
    const criticKey = criticName;
    if (!criticReviewsMap.has(criticKey)) criticReviewsMap.set(criticKey, []);
    criticReviewsMap.get(criticKey)!.push(profileReview);

    // Track outlets per critic
    if (!criticOutletsMap.has(criticKey)) criticOutletsMap.set(criticKey, new Map());
    const outletCounts = criticOutletsMap.get(criticKey)!;
    outletCounts.set(review.outlet, (outletCounts.get(review.outlet) || 0) + 1);

    // Track most recent review date per outlet per critic
    if (!criticOutletRecencyMap.has(criticKey)) criticOutletRecencyMap.set(criticKey, new Map());
    const recencyMap = criticOutletRecencyMap.get(criticKey)!;
    if (parsedDate && (!recencyMap.has(review.outlet) || parsedDate > recencyMap.get(review.outlet)!)) {
      recencyMap.set(review.outlet, parsedDate);
    }
  }
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

  // Count unique critics (excluding Unknown/null)
  const uniqueCritics = new Set(reviews.filter(r => r.criticName).map(r => r.criticName));

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

const criticProfilesList: CriticProfile[] = [];
for (const [criticName, reviews] of Array.from(criticReviewsMap.entries())) {
  const stats = computeStats(reviews);

  // Determine primary outlet (most reviews)
  const outletCounts = criticOutletsMap.get(criticName)!;
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
  const recencyMap = criticOutletRecencyMap.get(criticName);
  const outlets = Array.from(outletCounts.keys());
  if (recencyMap) {
    outlets.sort((a, b) => (recencyMap.get(b) || 0) - (recencyMap.get(a) || 0));
  }
  const isFreelancer = outlets.length >= 3;

  // Generate slug — collision handled with outlet disambiguation
  let slug = slugify(criticName);

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

  // Handle slug collision — disambiguate with primary outlet
  if (criticSlugMap.has(slug)) {
    slug = `${slug}-${slugify(primaryOutlet)}`;
    profile.slug = slug;
    // If still collides (extremely unlikely), append outletId
    if (criticSlugMap.has(slug)) {
      slug = `${slug}-${primaryOutletId}`;
      profile.slug = slug;
    }
  }
  criticSlugMap.set(slug, profile);
  criticProfilesList.push(profile);
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

// Build criticName → slug lookup from critic profiles
const criticNameToSlug = new Map<string, string>();
for (const critic of criticProfilesList) {
  criticNameToSlug.set(critic.name, critic.slug);
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

export function getCriticBySlug(slug: string): CriticProfile | undefined {
  return criticSlugMap.get(slug);
}

export function getAllCriticSlugs(): string[] {
  return Array.from(criticSlugMap.keys());
}

export function getOutletSlugById(outletId: string): string | null {
  return outletIdToSlug.get(outletId) || null;
}

export function getCriticSlugByName(name: string): string | null {
  return criticNameToSlug.get(name) || null;
}
