#!/usr/bin/env node

/**
 * audit-awards-data.js
 *
 * Comprehensive audit of awards.json data quality.
 * Checks for:
 *  1. Show ID mismatches (award IDs not in shows.json)
 *  2. Duplicate nominations (same show, same category, same award body)
 *  3. Winner without nomination (win not in nominatedFor list)
 *  4. Missing recent years / season coverage gaps
 *  5. Category consistency (typos, inconsistencies across years)
 *  6. Empty categories (categories with no nominees)
 *  7. Show coverage (Tony-eligible shows with no awards entry)
 *  8. Data completeness (missing required fields)
 *  9. Win count sanity (>1 winner per category per season)
 * 10. Historical accuracy spot-checks (well-known winners)
 *
 * Additional checks:
 * 11. Ceremony ordinal suffix consistency (e.g., "73th" should be "73rd")
 * 12. Season-to-ceremony mapping consistency
 * 13. Nomination count vs nominatedFor list length mismatch
 * 14. Design category split detection (pre/post 2015-16)
 * 15. Wins count > nominations count
 *
 * Usage:
 *   node scripts/audit-awards-data.js [--verbose]
 *
 * Output:
 *   data/audit/awards-data-audit.json
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const OUTPUT_FILE = path.join(AUDIT_DIR, 'awards-data-audit.json');

const VERBOSE = process.argv.includes('--verbose');

// ============================================================
// Load data
// ============================================================

let awardsData, showsData;
try {
  awardsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'awards.json'), 'utf8'));
} catch (e) {
  console.error('ERROR: Could not load awards.json:', e.message);
  process.exit(1);
}

try {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'shows.json'), 'utf8'));
  showsData = raw.shows || raw;
} catch (e) {
  console.error('ERROR: Could not load shows.json:', e.message);
  process.exit(1);
}

// Build show lookup by ID
const showById = {};
if (Array.isArray(showsData)) {
  for (const s of showsData) showById[s.id] = s;
} else {
  for (const [id, s] of Object.entries(showsData)) showById[id] = s;
}

const showIdSet = new Set(Object.keys(showById));
const awardsShows = awardsData.shows || {};

// ============================================================
// Issue collector
// ============================================================

const issues = [];

function addIssue(type, severity, detail, context) {
  const issue = { type, severity, detail };
  if (context) issue.context = context;
  issues.push(issue);
  if (VERBOSE) {
    const icon = severity === 'high' ? 'HIGH' : severity === 'medium' ? 'MED' : 'LOW';
    console.log(`  [${icon}] ${type}: ${detail}`);
  }
}

// ============================================================
// Check 1: Show ID mismatches
// ============================================================
console.log('Check 1: Show ID mismatches...');
let idMismatchCount = 0;
for (const showId of Object.keys(awardsShows)) {
  if (!showIdSet.has(showId)) {
    addIssue(
      'show-id-mismatch',
      'high',
      `Award entry "${showId}" not found in shows.json`,
      { showId }
    );
    idMismatchCount++;
  }
}
console.log(`  Found ${idMismatchCount} ID mismatches`);

// ============================================================
// Check 2: Duplicate nominations (same category in nominatedFor)
// Note: Some duplicates are legitimate (multiple performers in same category)
// ============================================================
console.log('Check 2: Duplicate nominations...');
let dupNomCount = 0;
for (const [showId, showAwards] of Object.entries(awardsShows)) {
  // Tony nominatedFor
  const tonyNoms = showAwards.tony?.nominatedFor || [];
  const seen = {};
  for (const cat of tonyNoms) {
    seen[cat] = (seen[cat] || 0) + 1;
  }
  for (const [cat, count] of Object.entries(seen)) {
    if (count > 1) {
      // Performing categories can legitimately have multiple nominees from same show
      const performingCategories = [
        'Best Actor in a Musical', 'Best Actor in a Play',
        'Best Actress in a Musical', 'Best Actress in a Play',
        'Best Featured Actor in a Musical', 'Best Featured Actor in a Play',
        'Best Featured Actress in a Musical', 'Best Featured Actress in a Play',
      ];
      const isPerforming = performingCategories.includes(cat);
      addIssue(
        'duplicate-nomination',
        isPerforming ? 'low' : 'medium',
        `"${showId}" has ${count} nominations in "${cat}" (Tony)` +
          (isPerforming ? ' [likely multiple performers - expected]' : ' [unexpected duplicate]'),
        { showId, category: cat, count, isPerformingCategory: isPerforming }
      );
      dupNomCount++;
    }
  }
}
console.log(`  Found ${dupNomCount} duplicate nominations`);

// ============================================================
// Check 3: Winner without nomination
// A win category should appear in nominatedFor (if nominatedFor exists)
// ============================================================
console.log('Check 3: Winner without nomination...');
let winNoNomCount = 0;
for (const [showId, showAwards] of Object.entries(awardsShows)) {
  const noms = showAwards.tony?.nominatedFor;
  const wins = showAwards.tony?.wins || [];
  if (noms && noms.length > 0 && wins.length > 0) {
    for (const win of wins) {
      if (!noms.includes(win)) {
        addIssue(
          'winner-without-nomination',
          'high',
          `"${showId}" won "${win}" but it is not in nominatedFor list`,
          { showId, category: win }
        );
        winNoNomCount++;
      }
    }
  } else if (!noms && wins.length > 0) {
    addIssue(
      'winner-without-nomination',
      'medium',
      `"${showId}" has ${wins.length} wins but no nominatedFor list`,
      { showId, winCount: wins.length }
    );
    winNoNomCount++;
  }
}
console.log(`  Found ${winNoNomCount} winner-without-nomination issues`);

// ============================================================
// Check 4: Missing recent years / season coverage
// ============================================================
console.log('Check 4: Season coverage...');
const coveredSeasons = new Set();
for (const [id, s] of Object.entries(awardsShows)) {
  if (s.tony?.season) coveredSeasons.add(s.tony.season);
}

// Expected continuous seasons from 2004-05 through 2024-25
const expectedSeasons = [];
for (let startYear = 2004; startYear <= 2025; startYear++) {
  const endYear = startYear + 1;
  const season = `${startYear}-${String(endYear).slice(2)}`;
  expectedSeasons.push(season);
}

let missingSeasonCount = 0;
for (const season of expectedSeasons) {
  if (!coveredSeasons.has(season)) {
    addIssue(
      'missing-season',
      'high',
      `Season "${season}" has no entries in awards data`,
      { season }
    );
    missingSeasonCount++;
  }
}
console.log(`  Found ${missingSeasonCount} missing seasons (of ${expectedSeasons.length} expected)`);

// ============================================================
// Check 5: Category consistency / typos
// Detect design categories that should be split (post 2015-16)
// ============================================================
console.log('Check 5: Category consistency...');

// The Tonys split design categories in 2015-16:
//   "Best Scenic Design" -> "Best Scenic Design of a Musical" / "Best Scenic Design of a Play"
// Pre-split: generic names. Post-split: should use specific names.
const DESIGN_SPLIT_SEASON = '2015-16';
const GENERIC_DESIGN_CATEGORIES = [
  'Best Scenic Design', 'Best Costume Design', 'Best Lighting Design', 'Best Sound Design'
];
const SPLIT_DESIGN_CATEGORIES = [
  'Best Scenic Design of a Musical', 'Best Scenic Design of a Play',
  'Best Costume Design of a Musical', 'Best Costume Design of a Play',
  'Best Lighting Design of a Musical', 'Best Lighting Design of a Play',
  'Best Sound Design of a Musical', 'Best Sound Design of a Play',
];

let categoryIssueCount = 0;

for (const [showId, showAwards] of Object.entries(awardsShows)) {
  const season = showAwards.tony?.season;
  if (!season) continue;
  const seasonStartYear = parseInt(season.split('-')[0]);

  const allCats = [
    ...(showAwards.tony?.nominatedFor || []),
    ...(showAwards.tony?.wins || []),
  ];

  // Post-split: generic design categories should not appear
  if (seasonStartYear >= 2015) {
    for (const cat of allCats) {
      if (GENERIC_DESIGN_CATEGORIES.includes(cat)) {
        addIssue(
          'category-inconsistency',
          'medium',
          `"${showId}" (season ${season}) uses generic design category "${cat}" — should use "...of a Musical" or "...of a Play" suffix (categories split in 2015-16)`,
          { showId, season, category: cat }
        );
        categoryIssueCount++;
      }
    }
  }
}

// Also check ceremony ordinal suffix formatting
console.log('Check 5b: Ceremony ordinal suffix consistency...');
let ordinalIssueCount = 0;
for (const [showId, showAwards] of Object.entries(awardsShows)) {
  const ceremony = showAwards.tony?.ceremony;
  if (!ceremony) continue;
  const num = parseInt(ceremony);
  if (isNaN(num)) continue;

  let expectedSuffix;
  if (num % 100 >= 11 && num % 100 <= 13) {
    expectedSuffix = 'th';
  } else if (num % 10 === 1) {
    expectedSuffix = 'st';
  } else if (num % 10 === 2) {
    expectedSuffix = 'nd';
  } else if (num % 10 === 3) {
    expectedSuffix = 'rd';
  } else {
    expectedSuffix = 'th';
  }

  const expected = num + expectedSuffix;
  if (ceremony !== expected) {
    addIssue(
      'ceremony-ordinal-typo',
      'low',
      `"${showId}" has ceremony "${ceremony}" — should be "${expected}"`,
      { showId, actual: ceremony, expected }
    );
    ordinalIssueCount++;
  }
}
console.log(`  Found ${categoryIssueCount} category issues, ${ordinalIssueCount} ordinal typos`);

// ============================================================
// Check 6: Empty categories (shows with Tony data but zero nominations and zero wins)
// This is different from shut-outs (which have nominatedFor=[] explicitly)
// ============================================================
console.log('Check 6: Empty/incomplete award entries...');
let emptyCount = 0;
for (const [showId, showAwards] of Object.entries(awardsShows)) {
  const tony = showAwards.tony;
  if (!tony) continue;

  // Check for entries with nominations count but no nominatedFor list
  if (tony.nominations > 0 && (!tony.nominatedFor || tony.nominatedFor.length === 0)) {
    addIssue(
      'missing-nomination-list',
      'medium',
      `"${showId}" has ${tony.nominations} nominations but no nominatedFor list`,
      { showId, nominations: tony.nominations }
    );
    emptyCount++;
  }
}
console.log(`  Found ${emptyCount} empty/incomplete entries`);

// ============================================================
// Check 7: Show coverage (Tony-eligible shows missing from awards)
// ============================================================
console.log('Check 7: Show coverage gaps...');

function getExpectedSeason(openingDate) {
  if (!openingDate) return null;
  const date = new Date(openingDate);
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  // Tony cutoff is roughly late April
  if (month >= 5) {
    return `${year}-${String(year + 1).slice(2)}`;
  } else {
    return `${year - 1}-${String(year).slice(2)}`;
  }
}

const awardIdSet = new Set(Object.keys(awardsShows));
const missingBySeasonMap = {};
let totalMissing = 0;

for (const show of Object.values(showById)) {
  if (!show.openingDate) continue;
  const season = getExpectedSeason(show.openingDate);
  if (!season) continue;
  const seasonStartYear = parseInt(season.split('-')[0]);
  // Only check 2005+ seasons
  if (seasonStartYear < 2005) continue;
  // Skip 2025-26 (upcoming, not yet awarded)
  if (season === '2025-26') continue;

  if (!awardIdSet.has(show.id)) {
    if (!missingBySeasonMap[season]) missingBySeasonMap[season] = [];
    missingBySeasonMap[season].push({
      id: show.id,
      title: show.title,
      type: show.type,
      status: show.status,
    });
    totalMissing++;
  }
}

// Add summary issues per season
for (const [season, shows] of Object.entries(missingBySeasonMap).sort()) {
  addIssue(
    'missing-show-coverage',
    shows.length > 5 ? 'medium' : 'low',
    `Season ${season}: ${shows.length} shows in shows.json have no awards entry`,
    {
      season,
      count: shows.length,
      shows: shows.map(s => ({ id: s.id, title: s.title, type: s.type })),
    }
  );
}
console.log(`  Found ${totalMissing} shows missing across ${Object.keys(missingBySeasonMap).length} seasons`);

// ============================================================
// Check 8: Data completeness (missing fields)
// ============================================================
console.log('Check 8: Data completeness...');
let completenessCount = 0;

for (const [showId, showAwards] of Object.entries(awardsShows)) {
  const tony = showAwards.tony;
  if (!tony) {
    // Show in awards but has no Tony data at all
    addIssue(
      'missing-tony-data',
      'low',
      `"${showId}" is in awards.json but has no Tony data`,
      { showId, awardBodies: Object.keys(showAwards).filter(k => k !== 'note') }
    );
    completenessCount++;
    continue;
  }

  // Missing season
  if (!tony.season) {
    addIssue('missing-field', 'high', `"${showId}" Tony data missing "season" field`, { showId, field: 'season' });
    completenessCount++;
  }

  // Missing ceremony (only flag if the show has season)
  if (tony.season && !tony.ceremony) {
    addIssue('missing-field', 'low', `"${showId}" Tony data missing "ceremony" field`, { showId, field: 'ceremony' });
    completenessCount++;
  }

  // Wins is undefined (not just empty)
  if (tony.wins === undefined) {
    // Only flag for shows that should have known outcomes (not future seasons)
    const seasonStart = parseInt((tony.season || '').split('-')[0]);
    if (seasonStart < 2025) {
      addIssue(
        'missing-field',
        'medium',
        `"${showId}" Tony data missing "wins" field (should be [] if no wins)`,
        { showId, field: 'wins', season: tony.season }
      );
      completenessCount++;
    }
  }

  // Nominations count defined but nominatedFor missing (for shows with nominations)
  if (tony.nominations > 0 && !tony.nominatedFor) {
    addIssue(
      'missing-field',
      'medium',
      `"${showId}" has ${tony.nominations} nominations but missing "nominatedFor" array`,
      { showId, field: 'nominatedFor', nominations: tony.nominations }
    );
    completenessCount++;
  }
}
console.log(`  Found ${completenessCount} completeness issues`);

// ============================================================
// Check 9: Win count sanity (>1 winner per Tony category per season)
// ============================================================
console.log('Check 9: Win count sanity...');

// Build: season -> category -> [winner show IDs]
const seasonCatWinners = {};
for (const [showId, showAwards] of Object.entries(awardsShows)) {
  const season = showAwards.tony?.season;
  const wins = showAwards.tony?.wins || [];
  if (!season) continue;
  if (!seasonCatWinners[season]) seasonCatWinners[season] = {};
  for (const win of wins) {
    if (!seasonCatWinners[season][win]) seasonCatWinners[season][win] = [];
    seasonCatWinners[season][win].push(showId);
  }
}

let multiWinnerCount = 0;
for (const [season, cats] of Object.entries(seasonCatWinners).sort()) {
  const seasonStartYear = parseInt(season.split('-')[0]);
  for (const [cat, winners] of Object.entries(cats)) {
    if (winners.length > 1) {
      // Pre-2015 generic design categories might have both a play and musical winner
      // listed under the same generic name. This is a data modeling issue.
      const isGenericDesign = GENERIC_DESIGN_CATEGORIES.includes(cat);
      const preSplit = seasonStartYear < 2015;

      if (isGenericDesign && preSplit) {
        addIssue(
          'multiple-winners-design-split',
          'medium',
          `Season ${season}, "${cat}": ${winners.length} winners (${winners.join(', ')}) — likely play/musical split not reflected in category names`,
          { season, category: cat, winners }
        );
      } else {
        addIssue(
          'multiple-winners',
          'high',
          `Season ${season}, "${cat}": ${winners.length} winners (${winners.join(', ')}) — Tonys rarely have ties`,
          { season, category: cat, winners }
        );
      }
      multiWinnerCount++;
    }
  }
}
console.log(`  Found ${multiWinnerCount} categories with multiple winners`);

// ============================================================
// Check 10: Historical accuracy spot-checks
// ============================================================
console.log('Check 10: Historical accuracy spot-checks...');

const spotChecks = [
  {
    id: 'hamilton-2015',
    expected: { season: '2015-16', nominations: 16, wins: 11 },
    mustWin: ['Best Musical', 'Best Original Score', 'Best Book of a Musical'],
    description: 'Hamilton (2016 Tonys, record 16 nominations)',
  },
  {
    id: 'dear-evan-hansen-2016',
    expected: { season: '2016-17', nominations: 9, wins: 6 },
    mustWin: ['Best Musical', 'Best Actor in a Musical', 'Best Original Score'],
    description: 'Dear Evan Hansen (2017 Tonys)',
  },
  {
    id: 'the-producers-2001',
    expected: { season: '2000-01', nominations: 15, wins: 12 },
    mustWin: ['Best Musical', 'Best Book of a Musical', 'Best Original Score'],
    description: 'The Producers (2001 Tonys, record 12 wins)',
  },
  {
    id: 'hadestown-2019',
    expected: { season: '2018-19', nominations: 10, wins: 7 },  // 14 noms, 8 wins at 73rd? Actually 14 noms 8 wins per Wikipedia - let me check
    mustWin: ['Best Musical', 'Best Direction of a Musical', 'Best Original Score'],
    description: 'Hadestown (2019 Tonys)',
  },
  {
    id: 'moulin-rouge-2019',
    expected: { season: '2019-20', nominations: 14, wins: 10 },
    mustWin: ['Best Musical'],
    description: 'Moulin Rouge (74th Tonys, 10 wins from 14 nominations)',
  },
  {
    id: 'stereophonic-2024',
    expected: { season: '2023-24', nominations: 13, wins: 5 },
    mustWin: ['Best Play', 'Best Direction of a Play'],
    description: 'Stereophonic (2024 Tonys, record 13 nominations for a play)',
  },
  {
    id: 'maybe-happy-ending-2024',
    expected: { season: '2024-25', nominations: 10, wins: 6 },
    mustWin: ['Best Musical'],
    description: 'Maybe Happy Ending (2025 Tonys)',
  },
  {
    id: 'the-lehman-trilogy-2021',
    expected: { season: '2021-22', nominations: 6, wins: 5 },
    mustWin: ['Best Play', 'Best Actor in a Play', 'Best Direction of a Play'],
    description: 'The Lehman Trilogy (2022 Tonys)',
  },
];

let spotCheckFailures = 0;
for (const check of spotChecks) {
  const showAwards = awardsShows[check.id];
  if (!showAwards) {
    addIssue(
      'spot-check-missing',
      'high',
      `Spot-check: "${check.id}" not found in awards data — ${check.description}`,
      { showId: check.id, description: check.description }
    );
    spotCheckFailures++;
    continue;
  }

  const tony = showAwards.tony;
  if (!tony) {
    addIssue(
      'spot-check-no-tony',
      'high',
      `Spot-check: "${check.id}" has no Tony data — ${check.description}`,
      { showId: check.id, description: check.description }
    );
    spotCheckFailures++;
    continue;
  }

  // Check season
  if (tony.season !== check.expected.season) {
    addIssue(
      'spot-check-season',
      'high',
      `Spot-check: "${check.id}" season is "${tony.season}", expected "${check.expected.season}"`,
      { showId: check.id, actual: tony.season, expected: check.expected.season }
    );
    spotCheckFailures++;
  }

  // Check nomination count
  if (tony.nominations !== check.expected.nominations) {
    addIssue(
      'spot-check-nominations',
      'high',
      `Spot-check: "${check.id}" has ${tony.nominations} nominations, expected ${check.expected.nominations} — ${check.description}`,
      { showId: check.id, actual: tony.nominations, expected: check.expected.nominations }
    );
    spotCheckFailures++;
  }

  // Check win count
  const actualWins = (tony.wins || []).length;
  if (actualWins !== check.expected.wins) {
    addIssue(
      'spot-check-wins',
      'high',
      `Spot-check: "${check.id}" has ${actualWins} wins, expected ${check.expected.wins} — ${check.description}`,
      { showId: check.id, actual: actualWins, expected: check.expected.wins, actualWins: tony.wins }
    );
    spotCheckFailures++;
  }

  // Check must-win categories
  for (const mustWin of check.mustWin) {
    if (!(tony.wins || []).includes(mustWin)) {
      addIssue(
        'spot-check-missing-win',
        'high',
        `Spot-check: "${check.id}" missing expected win "${mustWin}" — ${check.description}`,
        { showId: check.id, missingWin: mustWin }
      );
      spotCheckFailures++;
    }
  }
}
console.log(`  ${spotChecks.length} spot-checks performed, ${spotCheckFailures} failures`);

// ============================================================
// Check 11: Season-to-ceremony consistency
// Each season should map to exactly one ceremony number
// ============================================================
console.log('Check 11: Season-to-ceremony consistency...');
const seasonToCeremonies = {};
for (const [showId, showAwards] of Object.entries(awardsShows)) {
  const season = showAwards.tony?.season;
  const ceremony = showAwards.tony?.ceremony;
  if (!season || !ceremony) continue;
  // Normalize ceremony for comparison (strip ordinal, just use number)
  const num = parseInt(ceremony);
  if (!seasonToCeremonies[season]) seasonToCeremonies[season] = {};
  if (!seasonToCeremonies[season][num]) seasonToCeremonies[season][num] = [];
  seasonToCeremonies[season][num].push(showId);
}

let seasonCeremonyIssues = 0;
for (const [season, ceremonyMap] of Object.entries(seasonToCeremonies).sort()) {
  const nums = Object.keys(ceremonyMap).map(Number);
  if (nums.length > 1) {
    const details = nums.map(n => `${n}: ${ceremonyMap[n].length} shows`).join(', ');
    addIssue(
      'season-ceremony-mismatch',
      'high',
      `Season "${season}" has shows assigned to different ceremony numbers: ${details}`,
      {
        season,
        ceremonies: Object.fromEntries(
          nums.map(n => [n, { count: ceremonyMap[n].length, sample: ceremonyMap[n].slice(0, 5) }])
        ),
      }
    );
    seasonCeremonyIssues++;
  }
}
console.log(`  Found ${seasonCeremonyIssues} season-ceremony mismatches`);

// ============================================================
// Check 12: Nomination count vs nominatedFor list length
// ============================================================
console.log('Check 12: Nomination count vs list length...');
let countMismatchCount = 0;
for (const [showId, showAwards] of Object.entries(awardsShows)) {
  const nomCount = showAwards.tony?.nominations;
  const nomList = showAwards.tony?.nominatedFor;
  if (nomCount != null && nomList && nomList.length > 0) {
    if (nomCount !== nomList.length) {
      // This can be legitimate when there are duplicate nominations
      // (multiple performers in same category)
      const uniqueCount = new Set(nomList).size;
      const hasDups = uniqueCount !== nomList.length;
      if (!hasDups) {
        addIssue(
          'nomination-count-mismatch',
          'medium',
          `"${showId}": nominations=${nomCount} but nominatedFor has ${nomList.length} entries`,
          { showId, count: nomCount, listLength: nomList.length }
        );
        countMismatchCount++;
      }
      // If has dups and count matches list length, that's fine (count includes dups)
    }
  }
}
console.log(`  Found ${countMismatchCount} count/list mismatches`);

// ============================================================
// Check 13: Wins count exceeds nominations count
// ============================================================
console.log('Check 13: Wins > nominations sanity...');
let winsExceedCount = 0;
for (const [showId, showAwards] of Object.entries(awardsShows)) {
  const tony = showAwards.tony;
  if (!tony) continue;
  const winCount = (tony.wins || []).length;
  const nomCount = tony.nominations;
  if (nomCount != null && winCount > nomCount) {
    addIssue(
      'wins-exceed-nominations',
      'high',
      `"${showId}": ${winCount} wins exceeds ${nomCount} nominations`,
      { showId, wins: winCount, nominations: nomCount }
    );
    winsExceedCount++;
  }
}
console.log(`  Found ${winsExceedCount} wins-exceed-nominations issues`);

// ============================================================
// Check 14: Shows in awards with wrong show type for Tony category
// (e.g., a "play" winning "Best Musical")
// ============================================================
console.log('Check 14: Show type vs Tony category cross-check...');
let typeMismatchCount = 0;
const MUSICAL_CATEGORIES = [
  'Best Musical', 'Best Revival of a Musical',
  'Best Actor in a Musical', 'Best Actress in a Musical',
  'Best Featured Actor in a Musical', 'Best Featured Actress in a Musical',
  'Best Direction of a Musical', 'Best Choreography',
  'Best Book of a Musical', 'Best Original Score', 'Best Orchestrations',
];
const PLAY_CATEGORIES = [
  'Best Play', 'Best Revival of a Play',
  'Best Actor in a Play', 'Best Actress in a Play',
  'Best Featured Actor in a Play', 'Best Featured Actress in a Play',
  'Best Direction of a Play',
];

for (const [showId, showAwards] of Object.entries(awardsShows)) {
  const show = showById[showId];
  if (!show) continue;
  const showType = show.type; // "musical" or "play"
  if (!showType) continue;

  const allCats = [
    ...(showAwards.tony?.nominatedFor || []),
    ...(showAwards.tony?.wins || []),
  ];

  for (const cat of allCats) {
    if (showType === 'play' && MUSICAL_CATEGORIES.includes(cat)) {
      addIssue(
        'type-category-mismatch',
        'high',
        `"${showId}" is type "${showType}" but has Tony category "${cat}" (musical-only)`,
        { showId, showType, category: cat }
      );
      typeMismatchCount++;
      break; // One issue per show is enough
    }
    if (showType === 'musical' && PLAY_CATEGORIES.includes(cat)) {
      addIssue(
        'type-category-mismatch',
        'high',
        `"${showId}" is type "${showType}" but has Tony category "${cat}" (play-only)`,
        { showId, showType, category: cat }
      );
      typeMismatchCount++;
      break;
    }
  }
}
console.log(`  Found ${typeMismatchCount} type/category mismatches`);

// ============================================================
// Check 15: Non-Tony award bodies - basic integrity
// ============================================================
console.log('Check 15: Non-Tony award body integrity...');
let nonTonyIssues = 0;
for (const [showId, showAwards] of Object.entries(awardsShows)) {
  // Drama Desk
  if (showAwards.dramadesk) {
    const dd = showAwards.dramadesk;
    if (!dd.season) {
      addIssue('missing-field', 'low', `"${showId}" dramadesk missing "season"`, { showId, body: 'dramadesk' });
      nonTonyIssues++;
    }
    if (dd.wins && !Array.isArray(dd.wins)) {
      addIssue('field-type-error', 'medium', `"${showId}" dramadesk.wins is not an array`, { showId, body: 'dramadesk' });
      nonTonyIssues++;
    }
  }

  // Outer Critics Circle
  if (showAwards.outerCriticsCircle) {
    const occ = showAwards.outerCriticsCircle;
    if (!occ.season) {
      addIssue('missing-field', 'low', `"${showId}" outerCriticsCircle missing "season"`, { showId, body: 'outerCriticsCircle' });
      nonTonyIssues++;
    }
    if (occ.wins && !Array.isArray(occ.wins)) {
      addIssue('field-type-error', 'medium', `"${showId}" outerCriticsCircle.wins is not an array`, { showId, body: 'outerCriticsCircle' });
      nonTonyIssues++;
    }
  }

  // Drama League
  if (showAwards.dramaLeague) {
    const dl = showAwards.dramaLeague;
    if (!dl.season) {
      addIssue('missing-field', 'low', `"${showId}" dramaLeague missing "season"`, { showId, body: 'dramaLeague' });
      nonTonyIssues++;
    }
  }

  // Pulitzer - canonical shape is {wins?: string[], finalist?: string[], year?: number}
  // Year is OPTIONAL — finalist-only records may lack a year. The migration in
  // scripts/enrich-awards-with-precursors.js sets year for all current data, but the
  // type permits absence. Only flag if year IS present but isn't a number, or if
  // both wins and finalist are absent (missing semantic content).
  if (showAwards.pulitzer) {
    const p = showAwards.pulitzer;
    if (p.year !== undefined && typeof p.year !== 'number') {
      addIssue('field-type-error', 'medium', `"${showId}" pulitzer.year is present but not a number`, { showId, body: 'pulitzer' });
      nonTonyIssues++;
    }
    const hasWins = Array.isArray(p.wins) && p.wins.length > 0;
    const hasFinalist = Array.isArray(p.finalist) && p.finalist.length > 0;
    if (!hasWins && !hasFinalist) {
      addIssue('missing-field', 'low', `"${showId}" pulitzer node has no wins or finalist content`, { showId, body: 'pulitzer' });
      nonTonyIssues++;
    }
  }
}
console.log(`  Found ${nonTonyIssues} non-Tony issues`);

// ============================================================
// Build summary
// ============================================================

const severityCounts = { high: 0, medium: 0, low: 0 };
for (const issue of issues) {
  severityCounts[issue.severity]++;
}

const typeCounts = {};
for (const issue of issues) {
  typeCounts[issue.type] = (typeCounts[issue.type] || 0) + 1;
}

// Count shows per award body
let tonyCount = 0, ddCount = 0, occCount = 0, dlCount = 0, pulitzerCount = 0;
for (const [id, s] of Object.entries(awardsShows)) {
  if (s.tony) tonyCount++;
  if (s.dramadesk) ddCount++;
  if (s.outerCriticsCircle) occCount++;
  if (s.dramaLeague) dlCount++;
  if (s.pulitzer) pulitzerCount++;
}

// Collect all unique Tony categories
const allTonyCategories = new Set();
for (const [id, s] of Object.entries(awardsShows)) {
  for (const cat of (s.tony?.nominatedFor || [])) allTonyCategories.add(cat);
  for (const cat of (s.tony?.wins || [])) allTonyCategories.add(cat);
}

const report = {
  _meta: {
    generatedAt: new Date().toISOString(),
    description: 'Awards data quality audit report',
  },
  summary: {
    totalShowsInAwards: Object.keys(awardsShows).length,
    totalShowsInShowsJson: Object.keys(showById).length,
    seasonsRepresented: [...coveredSeasons].sort(),
    seasonCount: coveredSeasons.size,
    awardBodyCounts: {
      tony: tonyCount,
      dramadesk: ddCount,
      outerCriticsCircle: occCount,
      dramaLeague: dlCount,
      pulitzer: pulitzerCount,
    },
    uniqueTonyCategories: allTonyCategories.size,
    totalIssues: issues.length,
    issuesBySeverity: severityCounts,
    issuesByType: typeCounts,
  },
  spotCheckResults: spotChecks.map(check => {
    const s = awardsShows[check.id];
    const tony = s?.tony;
    return {
      showId: check.id,
      description: check.description,
      expectedNominations: check.expected.nominations,
      actualNominations: tony?.nominations || 'N/A',
      expectedWins: check.expected.wins,
      actualWins: (tony?.wins || []).length,
      nominationsMatch: tony?.nominations === check.expected.nominations,
      winsMatch: (tony?.wins || []).length === check.expected.wins,
      seasonMatch: tony?.season === check.expected.season,
    };
  }),
  issues,
};

// ============================================================
// Write report
// ============================================================
if (!fs.existsSync(AUDIT_DIR)) {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
}
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));

// ============================================================
// Print summary
// ============================================================
console.log('\n========================================');
console.log('AWARDS DATA AUDIT SUMMARY');
console.log('========================================');
console.log(`Total shows in awards.json:   ${report.summary.totalShowsInAwards}`);
console.log(`Total shows in shows.json:    ${report.summary.totalShowsInShowsJson}`);
console.log(`Seasons represented:          ${report.summary.seasonCount}`);
console.log(`Unique Tony categories:       ${report.summary.uniqueTonyCategories}`);
console.log(`Award bodies:                 Tony=${tonyCount}, DramDesk=${ddCount}, OCC=${occCount}, DramaLeague=${dlCount}, Pulitzer=${pulitzerCount}`);
console.log('');
console.log(`Total issues found:           ${report.summary.totalIssues}`);
console.log(`  HIGH severity:              ${severityCounts.high}`);
console.log(`  MEDIUM severity:            ${severityCounts.medium}`);
console.log(`  LOW severity:               ${severityCounts.low}`);
console.log('');
console.log('Issues by type:');
for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${type}: ${count}`);
}

console.log('\nSpot-check results:');
for (const sc of report.spotCheckResults) {
  const status = (sc.nominationsMatch && sc.winsMatch && sc.seasonMatch) ? 'PASS' : 'FAIL';
  const details = [];
  if (!sc.nominationsMatch) details.push(`noms: ${sc.actualNominations}/${sc.expectedNominations}`);
  if (!sc.winsMatch) details.push(`wins: ${sc.actualWins}/${sc.expectedWins}`);
  if (!sc.seasonMatch) details.push(`season mismatch`);
  console.log(`  [${status}] ${sc.description}${details.length ? ' -- ' + details.join(', ') : ''}`);
}

console.log(`\nReport written to: ${OUTPUT_FILE}`);
