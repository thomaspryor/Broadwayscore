#!/usr/bin/env node
/**
 * preview-gold-lists.js
 *
 * Computes and displays all 4 Gold Lists for the last 3 seasons.
 * Used for threshold tuning before building pages.
 *
 * Usage: node scripts/preview-gold-lists.js
 */

const path = require('path');
const dataDir = path.join(__dirname, '..', 'data');

// Load data
const showsRaw = require(path.join(dataDir, 'shows.json'));
const reviewsData = require(path.join(dataDir, 'reviews.json'));
const audienceBuzz = require(path.join(dataDir, 'audience-buzz.json'));
const grosses = require(path.join(dataDir, 'grosses.json'));
const grossesHistory = require(path.join(dataDir, 'grosses-history.json'));

// Normalize shows to array
const shows = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || Object.values(showsRaw));
const showMap = {};
shows.forEach(s => { showMap[s.id] = s; });

// Slug → show mapping
const slugMap = {};
shows.forEach(s => { if (s.slug) slugMap[s.slug] = s; });

// ============================================
// Outlet ID → Tier mapping (from scoring.ts + outlet-id-mapper.ts)
// ============================================
const REGISTRY_TO_SCORING = {
  // Tier 1
  'nytimes': 'NYT', 'washpost': 'WASHPOST', 'latimes': 'LATIMES', 'wsj': 'WSJ',
  'ap': 'AP', 'variety': 'VARIETY', 'hollywood-reporter': 'THR', 'vulture': 'VULT',
  'guardian': 'GUARDIAN', 'timeout': 'TIMEOUTNY', 'broadwaynews': 'BWAYNEWS',
  'newyorker': 'NEWYORKER',
  // Tier 2
  'chicagotribune': 'CHTRIB', 'usatoday': 'USATODAY', 'nydailynews': 'NYDN',
  'nypost': 'NYP', 'thewrap': 'WRAP', 'ew': 'EW', 'indiewire': 'INDIEWIRE',
  'deadline': 'DEADLINE', 'slantmagazine': 'SLANT', 'dailybeast': 'TDB',
  'observer': 'OBSERVER', 'nyt-theater': 'NYTHTR', 'nytg': 'NYTG', 'nysr': 'NYSR',
  'theatermania': 'TMAN', 'theatrely': 'THLY', 'newsday': 'NEWSDAY', 'time': 'TIME',
  'rollingstone': 'ROLLSTONE', 'bloomberg': 'BLOOMBERG', 'vox': 'VOX', 'slate': 'SLATE',
  'people': 'PEOPLE', 'parade': 'PARADE', 'billboard': 'BILLBOARD', 'huffpost': 'HUFFPOST',
  'backstage': 'BACKSTAGE', 'village-voice': 'VILLAGEVOICE', 'financial-times-uk': 'FT',
  // Tier 3
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

// ============================================
// Season logic (matches data-commercial.ts getSeason())
// ============================================
function getSeason(dateString) {
  if (!dateString) return null;
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed
  if (month >= 6) { // July onwards
    return `${year}-${year + 1}`;
  } else {
    return `${year - 1}-${year}`;
  }
}

// ============================================
// Target seasons
// ============================================
const TARGET_SEASONS = ['2022-2023', '2023-2024', '2024-2025'];

// ============================================
// 1. CRITICAL GOLD LIST
// ============================================
function computeCriticalGold() {
  console.log('\n' + '='.repeat(70));
  console.log('  CRITICAL GOLD LIST — Tier-weighted critic score');
  console.log('  Threshold: >= 73 | Min reviews: 5 | Max per season: 10');
  console.log('='.repeat(70));

  // Group reviews by showId
  const byShow = {};
  const allRevs = Object.values(reviewsData.reviews);
  allRevs.forEach(r => {
    if (!r.showId || r.assignedScore == null) return;
    if (!byShow[r.showId]) byShow[r.showId] = [];
    byShow[r.showId].push(r);
  });

  for (const season of TARGET_SEASONS) {
    const results = [];

    for (const [showId, revs] of Object.entries(byShow)) {
      const show = showMap[showId];
      if (!show || getSeason(show.openingDate) !== season) continue;
      if (revs.length < 5) continue;

      let weightedSum = 0, weightSum = 0;
      revs.forEach(r => {
        const w = getTierWeight(r.outletId);
        weightedSum += r.assignedScore * w;
        weightSum += w;
      });

      const score = weightedSum / weightSum;
      if (score < 73) continue;

      results.push({
        title: show.title,
        score: Math.round(score * 10) / 10,
        reviews: revs.length,
        type: show.type || '?',
      });
    }

    results.sort((a, b) => b.score - a.score);
    const list = results.slice(0, 10);

    console.log(`\n  ${season} Season (${list.length} qualifying shows)`);
    console.log('  ' + '-'.repeat(66));
    console.log('   #  Score  Revs  Type     Title');
    console.log('  ' + '-'.repeat(66));
    list.forEach((r, i) => {
      const rank = String(i + 1).padStart(2);
      const score = r.score.toFixed(1).padStart(5);
      const revs = String(r.reviews).padStart(4);
      const type = (r.type || '').padEnd(8);
      console.log(`  ${rank}. ${score}  ${revs}  ${type} ${r.title}`);
    });
    if (list.length === 0) console.log('  (No shows qualify)');
  }
}

// ============================================
// 2. AUDIENCE GOLD LIST
// ============================================
function computeAudienceGold() {
  console.log('\n' + '='.repeat(70));
  console.log('  AUDIENCE GOLD LIST — Combined audience score');
  console.log('  Threshold: >= 78 | Max per season: 10');
  console.log('='.repeat(70));

  const abShows = audienceBuzz.shows || audienceBuzz;

  for (const season of TARGET_SEASONS) {
    const results = [];

    for (const [showId, data] of Object.entries(abShows)) {
      const show = showMap[showId];
      if (!show || getSeason(show.openingDate) !== season) continue;
      if (data.combinedScore == null || data.combinedScore < 78) continue;

      const srcCount = data.sources
        ? Object.keys(data.sources).filter(k => data.sources[k] != null).length
        : 0;

      results.push({
        title: show.title,
        score: data.combinedScore,
        sources: srcCount,
        designation: data.designation || '',
        type: show.type || '?',
      });
    }

    results.sort((a, b) => b.score - a.score);
    const list = results.slice(0, 10);

    console.log(`\n  ${season} Season (${list.length} qualifying shows)`);
    console.log('  ' + '-'.repeat(66));
    console.log('   #  Score  Srcs  Type     Title');
    console.log('  ' + '-'.repeat(66));
    list.forEach((r, i) => {
      const rank = String(i + 1).padStart(2);
      const score = String(r.score).padStart(5);
      const srcs = String(r.sources).padStart(4);
      const type = (r.type || '').padEnd(8);
      console.log(`  ${rank}. ${score}  ${srcs}  ${type} ${r.title}`);
    });
    if (list.length === 0) console.log('  (No shows qualify)');
  }
}

// ============================================
// 3. BOX OFFICE GOLD LIST
// ============================================
function computeBoxOfficeGold() {
  console.log('\n' + '='.repeat(70));
  console.log('  BOX OFFICE GOLD LIST — Gross per performance');
  console.log('  Min performances: 50 | Max per season: 10');
  console.log('='.repeat(70));

  const showGrosses = grosses.shows || {};

  for (const season of TARGET_SEASONS) {
    const results = [];

    for (const [slug, data] of Object.entries(showGrosses)) {
      const show = slugMap[slug];
      if (!show || getSeason(show.openingDate) !== season) continue;

      const allTime = data.allTime;
      if (!allTime || !allTime.performances || allTime.performances < 50) continue;
      if (!allTime.gross || allTime.gross <= 0) continue;

      const grossPerPerf = allTime.gross / allTime.performances;

      results.push({
        title: show.title,
        grossPerPerf: Math.round(grossPerPerf),
        totalGross: allTime.gross,
        performances: allTime.performances,
        type: show.type || '?',
      });
    }

    results.sort((a, b) => b.grossPerPerf - a.grossPerPerf);
    const list = results.slice(0, 10);

    console.log(`\n  ${season} Season (${list.length} qualifying shows)`);
    console.log('  ' + '-'.repeat(76));
    console.log('   #  $/Perf    Total Gross   Perfs  Type     Title');
    console.log('  ' + '-'.repeat(76));
    list.forEach((r, i) => {
      const rank = String(i + 1).padStart(2);
      const gpp = ('$' + r.grossPerPerf.toLocaleString()).padStart(9);
      const total = ('$' + r.totalGross.toLocaleString()).padStart(14);
      const perfs = String(r.performances).padStart(5);
      const type = (r.type || '').padEnd(8);
      console.log(`  ${rank}. ${gpp}  ${total}  ${perfs}  ${type} ${r.title}`);
    });
    if (list.length === 0) console.log('  (No shows qualify with 50+ performances)');
  }
}

// ============================================
// 4. HOT TICKET GOLD LIST
// ============================================
function computeHotTicketGold() {
  console.log('\n' + '='.repeat(70));
  console.log('  HOT TICKET GOLD LIST — Average capacity %');
  console.log('  Threshold: >= 85% | Min weeks: 8 | Max per season: 10');
  console.log('='.repeat(70));

  const weeks = grossesHistory.weeks || {};
  const weekDates = Object.keys(weeks).sort();

  if (weekDates.length === 0) {
    console.log('\n  No grosses-history data available.');
    return;
  }

  console.log(`  Data range: ${weekDates[0]} → ${weekDates[weekDates.length - 1]} (${weekDates.length} weeks)`);

  for (const season of TARGET_SEASONS) {
    // Check if this season has data
    const seasonStart = season.split('-')[0];
    const seasonEnd = season.split('-')[1];
    const seasonStartDate = `${seasonStart}-07-01`;
    const seasonEndDate = `${seasonEnd}-06-30`;

    const seasonWeeks = weekDates.filter(d => d >= seasonStartDate && d <= seasonEndDate);

    if (seasonWeeks.length < 4) {
      console.log(`\n  ${season} Season — Insufficient data (grosses-history starts Jan 2025)`);
      continue;
    }

    // Collect capacity data per show for this season's weeks
    const showCapacity = {}; // slug → [capacity values]

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
      if (capacities.length < 8) continue;

      const show = slugMap[slug];
      if (!show || getSeason(show.openingDate) !== season) continue;

      const avgCapacity = capacities.reduce((a, b) => a + b, 0) / capacities.length;
      if (avgCapacity < 85) continue;

      results.push({
        title: show.title,
        avgCapacity: Math.round(avgCapacity * 10) / 10,
        weeks: capacities.length,
        type: show.type || '?',
      });
    }

    results.sort((a, b) => b.avgCapacity - a.avgCapacity);
    const list = results.slice(0, 10);

    console.log(`\n  ${season} Season (${list.length} qualifying shows, ${seasonWeeks.length} weeks of data)`);
    console.log('  ' + '-'.repeat(66));
    console.log('   #  Avg Cap  Weeks  Type     Title');
    console.log('  ' + '-'.repeat(66));
    list.forEach((r, i) => {
      const rank = String(i + 1).padStart(2);
      const cap = (r.avgCapacity.toFixed(1) + '%').padStart(7);
      const wks = String(r.weeks).padStart(5);
      const type = (r.type || '').padEnd(8);
      console.log(`  ${rank}. ${cap}  ${wks}  ${type} ${r.title}`);
    });
    if (list.length === 0) console.log('  (No shows qualify with 8+ weeks at 85%+ capacity)');
  }
}

// ============================================
// RUN
// ============================================
console.log('\n' + '#'.repeat(70));
console.log('  BROADWAY GOLD LISTS — Preview for Last 3 Seasons');
console.log('#'.repeat(70));

computeCriticalGold();
computeAudienceGold();
computeBoxOfficeGold();
computeHotTicketGold();

console.log('\n' + '#'.repeat(70));
console.log('  END OF PREVIEW');
console.log('#'.repeat(70) + '\n');
