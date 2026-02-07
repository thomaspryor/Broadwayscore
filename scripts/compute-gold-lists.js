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
const reviewsData = require(path.join(dataDir, 'reviews.json'));
const audienceBuzz = require(path.join(dataDir, 'audience-buzz.json'));
const grosses = require(path.join(dataDir, 'grosses.json'));
const grossesHistory = require(path.join(dataDir, 'grosses-history.json'));

const shows = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || Object.values(showsRaw));
const showById = {};
const showBySlug = {};
shows.forEach(s => { showById[s.id] = s; if (s.slug) showBySlug[s.slug] = s; });

// ============================================
// Outlet tier mapping (from scoring.ts + outlet-id-mapper.ts)
// ============================================
const REGISTRY_TO_SCORING = {
  'nytimes': 'NYT', 'washpost': 'WASHPOST', 'latimes': 'LATIMES', 'wsj': 'WSJ',
  'ap': 'AP', 'variety': 'VARIETY', 'hollywood-reporter': 'THR', 'vulture': 'VULT',
  'guardian': 'GUARDIAN', 'timeout': 'TIMEOUTNY', 'broadwaynews': 'BWAYNEWS',
  'newyorker': 'NEWYORKER',
  'chicagotribune': 'CHTRIB', 'usatoday': 'USATODAY', 'nydailynews': 'NYDN',
  'nypost': 'NYP', 'thewrap': 'WRAP', 'ew': 'EW', 'indiewire': 'INDIEWIRE',
  'deadline': 'DEADLINE', 'slantmagazine': 'SLANT', 'dailybeast': 'TDB',
  'observer': 'OBSERVER', 'nyt-theater': 'NYTHTR', 'nytg': 'NYTG', 'nysr': 'NYSR',
  'theatermania': 'TMAN', 'theatrely': 'THLY', 'newsday': 'NEWSDAY', 'time': 'TIME',
  'rollingstone': 'ROLLSTONE', 'bloomberg': 'BLOOMBERG', 'vox': 'VOX', 'slate': 'SLATE',
  'people': 'PEOPLE', 'parade': 'PARADE', 'billboard': 'BILLBOARD', 'huffpost': 'HUFFPOST',
  'backstage': 'BACKSTAGE', 'village-voice': 'VILLAGEVOICE', 'financial-times-uk': 'FT',
  'financialtimes': 'FT', 'financial-times': 'FT',
  'amny': 'AMNY', 'cititour': 'CITI', 'culturesauce': 'CSCE', 'frontmezzjunkies': 'FRONTMEZZ',
  'the-recs': 'THERECS', 'one-minute-critic': 'OMC', 'broadwayworld': 'BWW',
  'stageandcinema': 'STGCNMA', 'talkinbroadway': 'TALKINBWAY', 'ny1': 'NY1',
  'curtainup': 'CURTAINUP', 'theater-scene': 'THEATERSCENE', 'njcom': 'NJCOM',
  'stagezine': 'STAGEZINE', 'mashable': 'MASHABLE', 'wnyc': 'WNYC', 'queerty': 'QUEERTY',
  'medium': 'MEDIUM', 'exeunt-magazine': 'EXEUNT', 'towleroad': 'TOWLEROAD',
  'northjerseycom': 'NORTHJERSEY', 'nbcny': 'NBC',
};

const TIER1 = new Set(['NYT', 'WASHPOST', 'LATIMES', 'WSJ', 'AP', 'VARIETY', 'THR', 'VULT', 'GUARDIAN', 'TIMEOUTNY', 'BWAYNEWS', 'NEWYORKER']);
const TIER2 = new Set(['CHTRIB', 'USATODAY', 'NYDN', 'NYP', 'WRAP', 'EW', 'INDIEWIRE', 'DEADLINE', 'SLANT', 'TDB', 'OBSERVER', 'NYTHTR', 'NYTG', 'NYSR', 'TMAN', 'THLY', 'NEWSDAY', 'TIME', 'ROLLSTONE', 'BLOOMBERG', 'VOX', 'SLATE', 'PEOPLE', 'PARADE', 'BILLBOARD', 'HUFFPOST', 'BACKSTAGE', 'VILLAGEVOICE', 'FT']);
const TIER_WEIGHTS = { 1: 1.0, 2: 0.75, 3: 0.45 };

function getTierWeight(outletId) {
  const scoringId = REGISTRY_TO_SCORING[outletId] || outletId.toUpperCase();
  if (TIER1.has(scoringId)) return TIER_WEIGHTS[1];
  if (TIER2.has(scoringId)) return TIER_WEIGHTS[2];
  return TIER_WEIGHTS[3];
}

// Thresholds (must match src/config/gold-lists.ts)
const THRESHOLDS = {
  'critical-gold': { minScore: 73, minReviews: 5, maxPerSeason: 10, maxAllTime: 25 },
  'audience-gold': { minScore: 78, maxPerSeason: 10, maxAllTime: 25 },
  'box-office-gold': { minPerformances: 50, maxPerSeason: 10, maxAllTime: 25 },
  'hot-ticket-gold': { minCapacity: 85, minWeeks: 8, maxPerSeason: 10, maxAllTime: 25 },
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
// Computation functions
// ============================================

function computeCriticalGold(season, uncapped = false) {
  const cfg = THRESHOLDS['critical-gold'];
  const byShow = {};
  Object.values(reviewsData.reviews).forEach(r => {
    if (!r.showId || r.assignedScore == null) return;
    if (!byShow[r.showId]) byShow[r.showId] = [];
    byShow[r.showId].push(r);
  });

  const results = [];
  for (const [showId, revs] of Object.entries(byShow)) {
    const show = showById[showId];
    if (!show || getSeason(show.openingDate) !== season) continue;
    if (revs.length < cfg.minReviews) continue;

    let weightedSum = 0, weightSum = 0;
    revs.forEach(r => {
      if (r.assignedScore == null) return;
      const w = getTierWeight(r.outletId);
      weightedSum += r.assignedScore * w;
      weightSum += w;
    });
    if (weightSum === 0) continue;

    const score = weightedSum / weightSum;
    if (score < cfg.minScore) continue;

    const rounded = Math.round(score * 10) / 10;
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

function computeAudienceGold(season, uncapped = false) {
  const cfg = THRESHOLDS['audience-gold'];
  const abShows = audienceBuzz.shows || {};
  const results = [];

  for (const [showId, data] of Object.entries(abShows)) {
    const show = showById[showId];
    if (!show || getSeason(show.openingDate) !== season) continue;
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

function computeBoxOfficeGold(season, uncapped = false) {
  const cfg = THRESHOLDS['box-office-gold'];
  const showGrosses = grosses.shows || {};
  const results = [];

  for (const [slug, data] of Object.entries(showGrosses)) {
    const show = showBySlug[slug];
    if (!show || getSeason(show.openingDate) !== season) continue;
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
    if (!show || getSeason(show.openingDate) !== season) continue;

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

function computeAllTime(type) {
  const cfg = THRESHOLDS[type];
  const computeFns = {
    'critical-gold': computeCriticalGold,
    'audience-gold': computeAudienceGold,
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
const listTypes = ['critical-gold', 'audience-gold', 'box-office-gold', 'hot-ticket-gold'];

const lists = {};
const memberships = {};

for (const type of listTypes) {
  lists[type] = {};

  for (const season of allSeasons) {
    const entries = type === 'critical-gold' ? computeCriticalGold(season) :
                    type === 'audience-gold' ? computeAudienceGold(season) :
                    type === 'box-office-gold' ? computeBoxOfficeGold(season) :
                    computeHotTicketGold(season);

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
