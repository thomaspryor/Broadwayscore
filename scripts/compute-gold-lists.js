#!/usr/bin/env node
/**
 * compute-gold-lists.js
 *
 * Pre-computes Gold List data and writes to data/gold-lists-computed.json.
 * Run as part of the prebuild step so show pages can import lightweight data
 * without pulling in reviews.json, grosses-history.json, etc.
 *
 * Output schema:
 * {
 *   _meta: { lastComputed, version },
 *   seasons: ["2024-2025", "2023-2024", ...],
 *   lists: {
 *     "critical-gold": { "2024-2025": [...], "all-time": [...] },
 *     ...
 *   },
 *   memberships: {
 *     "show-id": [{ listType, season, rank }],
 *     ...
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const outputPath = path.join(dataDir, 'gold-lists-computed.json');

// Load data
const showsRaw = require(path.join(dataDir, 'shows.json'));
const audienceBuzz = require(path.join(dataDir, 'audience-buzz.json'));
const grosses = require(path.join(dataDir, 'grosses.json'));
const grossesHistory = require(path.join(dataDir, 'grosses-history.json'));

// reviews.json + blog-reviews-for-scoring.json concatenated.
// Uses shared helper so gold list scores stay in lock-step with show page
// scores (src/lib/data-core.ts). See scripts/lib/load-reviews-with-blog.js.
const { loadReviewsWithBlog } = require('./lib/load-reviews-with-blog');
const reviewsList = loadReviewsWithBlog();

const shows = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || Object.values(showsRaw));
const showById = {};
const showBySlug = {};
shows.forEach(s => { showById[s.id] = s; if (s.slug) showBySlug[s.slug] = s; });

const { isOfficialBroadwayTheater } = require('./lib/broadway-theaters');

// Pre-compute market classification per show (isOfficialBroadwayTheater is expensive — O(n) scan per call).
// Broadway = venue-based (official Broadway theater AND no overriding category).
// Everything else is category-based: west-end, off-west-end, off-broadway are disjoint sets.
const broadwayShowIds = new Set();
const westEndShowIds = new Set();      // category === 'west-end' only (NOT off-west-end)
const offWestEndShowIds = new Set();   // category === 'off-west-end' only
const offBroadwayShowIds = new Set();  // category === 'off-broadway' only
shows.forEach(s => {
  if (s.category === 'west-end') westEndShowIds.add(s.id);
  else if (s.category === 'off-west-end') offWestEndShowIds.add(s.id);
  else if (s.category === 'off-broadway') offBroadwayShowIds.add(s.id);
  else if (!s.category || s.category === 'broadway') {
    if (isOfficialBroadwayTheater(s.venue)) broadwayShowIds.add(s.id);
  }
});

function isBroadway(show)   { return show ? broadwayShowIds.has(show.id)   : false; }
function isWestEnd(show)    { return show ? westEndShowIds.has(show.id)    : false; }
function isOffWestEnd(show) { return show ? offWestEndShowIds.has(show.id) : false; }
function isOffBroadway(show){ return show ? offBroadwayShowIds.has(show.id): false; }

// ============================================
// Tier-weighted scoring — use the SAME shared module as engine.ts / homepage-archive
// so gold list scores exactly match the show page.
// ============================================
const { computeCriticScore } = require('./lib/compute-critic-score');
const { TIER_WEIGHTS } = require('./lib/outlet-tiers');

// Load outlet-registry.json → flat outlets map (shared module expects {outletId: {tier}}, NOT the wrapping envelope)
const outletRegistryData = require(path.join(dataDir, 'outlet-registry.json'));
const outletRegistry = outletRegistryData.outlets || outletRegistryData;

// Thresholds (must match src/config/gold-lists.ts).
// minReviews matches src/lib/market-utils.ts::getMarketMinReviews():
//   3 for Off-Broadway + any London market, 5 for Broadway.
const THRESHOLDS = {
  'critical-gold':              { minScore: 73, minReviews: 5, maxPerSeason: 10, maxAllTime: 25 },
  'critical-gold-west-end':     { minScore: 73, minReviews: 3, maxPerSeason: 10, maxAllTime: 25 },
  'critical-gold-off-broadway': { minScore: 73, minReviews: 3, maxPerSeason: 10, maxAllTime: 25 },
  'critical-gold-off-west-end': { minScore: 73, minReviews: 3, maxPerSeason: 10, maxAllTime: 25 },
  'audience-gold':              { minScore: 78, maxPerSeason: 10, maxAllTime: 25 },
  'audience-gold-off-broadway': { minScore: 78, maxPerSeason: 10, maxAllTime: 25 },
  'audience-gold-west-end':     { minScore: 78, maxPerSeason: 10, maxAllTime: 25 },
  'audience-gold-off-west-end': { minScore: 78, maxPerSeason: 10, maxAllTime: 25 },
  'box-office-gold':   { minPerformances: 50, maxPerSeason: 10, maxAllTime: 25 },
  'hot-ticket-gold':   { minCapacity: 85, minWeeks: 8, maxPerSeason: 10, maxAllTime: 25 },
};

// ============================================
// Season logic
// ============================================
function getSeason(dateString) {
  if (!dateString) return null;
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = date.getMonth();
  return month >= 6 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

function getAllSeasons() {
  const seasons = new Set();
  shows.forEach(s => {
    const season = getSeason(s.openingDate);
    if (season) seasons.add(season);
  });
  return Array.from(seasons).sort().reverse();
}

// ============================================
// Pre-compute reviews grouped by show (avoids re-iterating 14K+ reviews per season)
// ============================================
const reviewsByShow = {};
reviewsList.forEach(r => {
  if (!r.showId || r.assignedScore == null) return;
  if (!reviewsByShow[r.showId]) reviewsByShow[r.showId] = [];
  reviewsByShow[r.showId].push(r);
});

// ============================================
// Computation functions
// ============================================

/**
 * Generic critical-gold computer — parameterized by list type and membership filter.
 * Uses the shared computeCriticScore() so scores exactly match the show page.
 */
function computeCriticalGoldForMarket(listType, membershipFilter, season, uncapped = false) {
  const cfg = THRESHOLDS[listType];

  const results = [];
  for (const [showId, revs] of Object.entries(reviewsByShow)) {
    const show = showById[showId];
    if (!show || !membershipFilter(show) || getSeason(show.openingDate) !== season) continue;
    if (revs.length < cfg.minReviews) continue;

    // Canonical tier-weighted score: dedup + OUTLET_TIERS + designation bumps + confidence weights
    const scoreResult = computeCriticScore(revs, outletRegistry, show.category);
    if (!scoreResult) continue;
    // Apply minReviews to the deduped count, not raw count
    if (scoreResult.rc < cfg.minReviews) continue;
    if (scoreResult.s < cfg.minScore) continue;

    const rounded = Math.round(scoreResult.s * 10) / 10;
    results.push({
      showId: show.id, title: show.title, slug: show.slug,
      rank: 0, value: rounded, displayValue: rounded.toFixed(1),
      season, venue: show.venue, type: show.type,
      thumbnail: show.images?.thumbnail || null,
      openingDate: show.openingDate || null,
      closingDate: show.closingDate || null,
      status: show.status || null,
      isRevival: !!(show.tags && show.tags.includes('revival')),
    });
  }

  results.sort((a, b) => b.value - a.value);
  if (!uncapped) results.splice(cfg.maxPerSeason);
  return results.map((e, i) => ({ ...e, rank: i + 1 }));
}

function computeCriticalGold(season, uncapped = false) {
  return computeCriticalGoldForMarket('critical-gold', isBroadway, season, uncapped);
}

function computeAudienceGoldForMarket(listType, membershipFilter, season, uncapped = false) {
  const cfg = THRESHOLDS[listType];
  const abShows = audienceBuzz.shows || {};
  const results = [];

  for (const [showId, data] of Object.entries(abShows)) {
    const show = showById[showId];
    if (!show || !membershipFilter(show) || getSeason(show.openingDate) !== season) continue;
    if (data.combinedScore == null || data.combinedScore < cfg.minScore) continue;

    results.push({
      showId: show.id, title: show.title, slug: show.slug,
      rank: 0, value: data.combinedScore, displayValue: String(data.combinedScore),
      season, venue: show.venue, type: show.type, thumbnail: show.images?.thumbnail || null,
      openingDate: show.openingDate || null,
      closingDate: show.closingDate || null,
      status: show.status || null,
      isRevival: !!(show.tags && show.tags.includes('revival')),
    });
  }

  results.sort((a, b) => b.value - a.value);
  if (!uncapped) results.splice(cfg.maxPerSeason);
  return results.map((e, i) => ({ ...e, rank: i + 1 }));
}

function computeAudienceGold(season, uncapped = false) {
  return computeAudienceGoldForMarket('audience-gold', isBroadway, season, uncapped);
}
function computeAudienceGoldOffBroadway(season, uncapped = false) {
  return computeAudienceGoldForMarket('audience-gold-off-broadway', isOffBroadway, season, uncapped);
}
function computeAudienceGoldWestEnd(season, uncapped = false) {
  return computeAudienceGoldForMarket('audience-gold-west-end', isWestEnd, season, uncapped);
}
function computeAudienceGoldOffWestEnd(season, uncapped = false) {
  return computeAudienceGoldForMarket('audience-gold-off-west-end', isOffWestEnd, season, uncapped);
}

function computeBoxOfficeGold(season, uncapped = false) {
  const cfg = THRESHOLDS['box-office-gold'];
  const showGrosses = grosses.shows || {};
  const results = [];

  for (const [slug, data] of Object.entries(showGrosses)) {
    const show = showBySlug[slug];
    if (!show || !isBroadway(show) || getSeason(show.openingDate) !== season) continue;
    const allTime = data.allTime;
    if (!allTime || !allTime.performances || allTime.performances < cfg.minPerformances) continue;
    if (!allTime.gross || allTime.gross <= 0) continue;

    const grossPerPerf = allTime.gross / allTime.performances;
    results.push({
      showId: show.id, title: show.title, slug: show.slug,
      rank: 0, value: Math.round(grossPerPerf),
      displayValue: '$' + Math.round(grossPerPerf).toLocaleString('en-US'),
      season, venue: show.venue, type: show.type, thumbnail: show.images?.thumbnail || null,
      openingDate: show.openingDate || null,
      closingDate: show.closingDate || null,
      status: show.status || null,
      isRevival: !!(show.tags && show.tags.includes('revival')),
    });
  }

  results.sort((a, b) => b.value - a.value);
  if (!uncapped) results.splice(cfg.maxPerSeason);
  return results.map((e, i) => ({ ...e, rank: i + 1 }));
}

function computeHotTicketGold(season, uncapped = false) {
  const cfg = THRESHOLDS['hot-ticket-gold'];
  const weeks = grossesHistory.weeks || {};
  const weekDates = Object.keys(weeks).sort();
  if (weekDates.length === 0) return [];

  const [startYear] = season.split('-');
  const seasonStartDate = `${startYear}-07-01`;
  const seasonEndDate = `${parseInt(startYear) + 1}-06-30`;
  const seasonWeeks = weekDates.filter(d => d >= seasonStartDate && d <= seasonEndDate);
  if (seasonWeeks.length < 4) return [];

  const showCapacity = {};
  for (const weekDate of seasonWeeks) {
    const weekData = weeks[weekDate];
    for (const [slug, data] of Object.entries(weekData)) {
      if (data.capacity == null) continue;
      if (!showCapacity[slug]) showCapacity[slug] = [];
      showCapacity[slug].push(data.capacity);
    }
  }

  const results = [];
  for (const [slug, capacities] of Object.entries(showCapacity)) {
    if (capacities.length < cfg.minWeeks) continue;
    const show = showBySlug[slug];
    if (!show || !isBroadway(show) || getSeason(show.openingDate) !== season) continue;

    const avgCapacity = capacities.reduce((a, b) => a + b, 0) / capacities.length;
    if (avgCapacity < cfg.minCapacity) continue;

    const rounded = Math.round(avgCapacity * 10) / 10;
    results.push({
      showId: show.id, title: show.title, slug: show.slug,
      rank: 0, value: rounded, displayValue: rounded.toFixed(1) + '%',
      season, venue: show.venue, type: show.type, thumbnail: show.images?.thumbnail || null,
      openingDate: show.openingDate || null,
      closingDate: show.closingDate || null,
      status: show.status || null,
      isRevival: !!(show.tags && show.tags.includes('revival')),
    });
  }

  results.sort((a, b) => b.value - a.value);
  if (!uncapped) results.splice(cfg.maxPerSeason);
  return results.map((e, i) => ({ ...e, rank: i + 1 }));
}

function computeCriticalGoldWestEnd(season, uncapped = false) {
  return computeCriticalGoldForMarket('critical-gold-west-end', isWestEnd, season, uncapped);
}

function computeCriticalGoldOffBroadway(season, uncapped = false) {
  return computeCriticalGoldForMarket('critical-gold-off-broadway', isOffBroadway, season, uncapped);
}

function computeCriticalGoldOffWestEnd(season, uncapped = false) {
  return computeCriticalGoldForMarket('critical-gold-off-west-end', isOffWestEnd, season, uncapped);
}

function computeAllTime(type) {
  const cfg = THRESHOLDS[type];
  const computeFns = {
    'critical-gold': computeCriticalGold,
    'critical-gold-west-end': computeCriticalGoldWestEnd,
    'critical-gold-off-broadway': computeCriticalGoldOffBroadway,
    'critical-gold-off-west-end': computeCriticalGoldOffWestEnd,
    'audience-gold': computeAudienceGold,
    'audience-gold-off-broadway': computeAudienceGoldOffBroadway,
    'audience-gold-west-end': computeAudienceGoldWestEnd,
    'audience-gold-off-west-end': computeAudienceGoldOffWestEnd,
    'box-office-gold': computeBoxOfficeGold,
    'hot-ticket-gold': computeHotTicketGold,
  };

  const fn = computeFns[type];
  const allSeasons = getAllSeasons();
  const allEntries = [];

  for (const season of allSeasons) {
    allEntries.push(...fn(season, true)); // uncapped
  }

  allEntries.sort((a, b) => b.value - a.value);
  allEntries.splice(cfg.maxAllTime);
  return allEntries.map((e, i) => ({ ...e, rank: i + 1 }));
}

// ============================================
// Main
// ============================================

const allSeasons = getAllSeasons();
const listTypes = [
  'critical-gold',
  'critical-gold-west-end',
  'critical-gold-off-broadway',
  'critical-gold-off-west-end',
  'audience-gold',
  'audience-gold-off-broadway',
  'audience-gold-west-end',
  'audience-gold-off-west-end',
  'box-office-gold',
  'hot-ticket-gold',
];

const lists = {};
const memberships = {};

for (const type of listTypes) {
  lists[type] = {};

  for (const season of allSeasons) {
    const computeFnMap = {
      'critical-gold': computeCriticalGold,
      'critical-gold-west-end': computeCriticalGoldWestEnd,
      'critical-gold-off-broadway': computeCriticalGoldOffBroadway,
      'critical-gold-off-west-end': computeCriticalGoldOffWestEnd,
      'audience-gold': computeAudienceGold,
      'audience-gold-off-broadway': computeAudienceGoldOffBroadway,
      'audience-gold-west-end': computeAudienceGoldWestEnd,
      'audience-gold-off-west-end': computeAudienceGoldOffWestEnd,
      'box-office-gold': computeBoxOfficeGold,
      'hot-ticket-gold': computeHotTicketGold,
    };
    const entries = computeFnMap[type](season);

    if (entries.length > 0) {
      lists[type][season] = entries;

      // Track memberships
      for (const entry of entries) {
        if (!memberships[entry.showId]) memberships[entry.showId] = [];
        memberships[entry.showId].push({
          listType: type,
          season,
          rank: entry.rank,
        });
      }
    }
  }

  // All-time
  const allTime = computeAllTime(type);
  if (allTime.length > 0) {
    lists[type]['all-time'] = allTime;

    for (const entry of allTime) {
      if (!memberships[entry.showId]) memberships[entry.showId] = [];
      // Avoid duplicate membership if already on season list
      const existing = memberships[entry.showId];
      const alreadyHasAllTime = existing.some(m => m.listType === type && m.season === 'all-time');
      if (!alreadyHasAllTime) {
        existing.push({
          listType: type,
          season: 'all-time',
          rank: entry.rank,
        });
      }
    }
  }
}

// Discover seasons that actually have lists
const seasonsWithLists = new Set();
for (const type of listTypes) {
  for (const season of Object.keys(lists[type])) {
    if (season !== 'all-time') seasonsWithLists.add(season);
  }
}

const output = {
  _meta: {
    lastComputed: new Date().toISOString().split('T')[0],
    version: '1.0',
    description: 'Pre-computed Gold List data. Generated by scripts/compute-gold-lists.js',
  },
  seasons: Array.from(seasonsWithLists).sort().reverse(),
  lists,
  memberships,
};

// Early-warning diff: compare per-list entry count vs prior run before overwriting.
// Helps catch "threshold no longer calibrated" regressions early.
let priorCounts = null;
if (fs.existsSync(outputPath)) {
  try {
    const prior = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    priorCounts = {};
    for (const type of Object.keys(prior.lists || {})) {
      priorCounts[type] = {};
      for (const [season, entries] of Object.entries(prior.lists[type] || {})) {
        priorCounts[type][season] = entries.length;
      }
    }
  } catch { /* ignore — fresh run */ }
}

fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

// Stats
let totalEntries = 0;
let totalMemberships = 0;
for (const type of listTypes) {
  for (const [season, entries] of Object.entries(lists[type])) {
    totalEntries += entries.length;
  }
}
for (const showMemberships of Object.values(memberships)) {
  totalMemberships += showMemberships.length;
}

console.log(`Gold Lists computed:`);
console.log(`  Seasons: ${Array.from(seasonsWithLists).length}`);
console.log(`  Total list entries: ${totalEntries}`);
console.log(`  Shows with memberships: ${Object.keys(memberships).length}`);
console.log(`  Total memberships: ${totalMemberships}`);
console.log(`  Output: ${outputPath} (${Math.round(fs.statSync(outputPath).size / 1024)}KB)`);

// Per-list entry count delta vs prior run (if available)
if (priorCounts) {
  console.log('\nPer-list entry count delta vs prior run:');
  const allTypes = new Set([...Object.keys(priorCounts), ...listTypes]);
  for (const type of allTypes) {
    const prior = priorCounts[type] || {};
    const curr = lists[type] || {};
    let priorTotal = 0, currTotal = 0;
    for (const n of Object.values(prior)) priorTotal += n;
    for (const entries of Object.values(curr)) currTotal += entries.length;
    const delta = currTotal - priorTotal;
    const sign = delta > 0 ? '+' : '';
    const marker = Math.abs(delta) > Math.max(priorTotal * 0.25, 5) ? ' ⚠️' : '';
    console.log(`  ${type.padEnd(32)} ${String(priorTotal).padStart(4)} → ${String(currTotal).padStart(4)} (${sign}${delta})${marker}`);
  }
}
