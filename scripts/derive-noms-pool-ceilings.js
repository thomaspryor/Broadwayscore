#!/usr/bin/env node
/**
 * Derive per-Tony-category NOMS_POOL ceilings empirically.
 *
 * Reads the FROZEN baseline `data/audit/tony-pre-tier-weights/awards.json.snapshot`
 * (NOT live data/awards.json — ceilings must be stable across rollout, per
 * /ship-check primary failure scenario "ceilings re-derived from broken data
 * normalize the hole").
 *
 * For each backtested-season Tony nominee, computes weightedNoms using the
 * same tier-weighted formula as src/lib/data-tony-predictions.ts:computeAwardsScore
 * (skipping the matching top cat, weighting other noms by classifyCategory tier).
 *
 * Outputs `data/audit/derived-noms-pool-ceilings.json` with 95th-percentile
 * weighted-noms per Tony category. Manual: copy values into
 * NOMS_POOL_BY_CATEGORY constant after eyeball check.
 *
 * NOTE: current snapshot has precursor nominatedFor arrays containing only
 * the matching top cat (no Director/Acting/etc per-cat noms). Until Sprint 2
 * backfills those, weightedNoms will be 0 for everyone and the script will
 * emit a warning + write all-zero ceilings (which means: don't update
 * NOMS_POOL_BY_CATEGORY from this run yet).
 */

const fs = require('fs');
const path = require('path');

const SNAPSHOT_PATH = path.join(__dirname, '..', 'data/audit/tony-pre-tier-weights/awards.json.snapshot');
const OUTPUT_PATH = path.join(__dirname, '..', 'data/audit/derived-noms-pool-ceilings.json');

// Mirror src/lib/data-tony-predictions.ts:TONY_TO_PRECURSOR_CATEGORY
const TONY_TO_PRECURSOR_CATEGORY = {
  'Best Musical': {
    dramadesk: 'Outstanding Musical',
    outerCriticsCircle: 'Outstanding New Broadway Musical',
    dramaLeague: 'Outstanding Production of a Musical',
  },
  'Best Play': {
    dramadesk: 'Outstanding Play',
    outerCriticsCircle: 'Outstanding New Broadway Play',
    dramaLeague: 'Outstanding Production of a Play',
  },
  'Best Revival of a Musical': {
    dramadesk: 'Outstanding Revival of a Musical',
    outerCriticsCircle: 'Outstanding Revival of a Musical',
    dramaLeague: 'Outstanding Revival of a Musical',
  },
  'Best Revival of a Play': {
    dramadesk: 'Outstanding Revival of a Play',
    outerCriticsCircle: 'Outstanding Revival of a Play',
    dramaLeague: 'Outstanding Revival of a Play',
  },
};

// Mirror src/lib/awards-scoring.ts:classifyCategory (TS → JS regex literal-for-literal).
// MUST stay in lockstep with the TS source — if you add a pattern to
// awards-scoring.ts:classifyCategory, mirror it here. Codex /ship-check caught
// this drifting after the DD 70th "Lead/Featured Performance" patterns were
// added to TS but not here (2026-05-16).
function classifyCategory(category) {
  const c = category.toLowerCase();
  if (/revival of a musical|musical revival/.test(c)) return { tier: 'S', revival: true };
  if (/revival of a play|play revival/.test(c)) return { tier: 'S', revival: true };
  if (/best musical$|outstanding musical$|outstanding new (broadway|off-broadway) musical|outstanding production of a (broadway or off-broadway )?musical/.test(c)) return { tier: 'S', revival: false };
  if (/best play$|outstanding play$|outstanding new broadway play|outstanding production of a play/.test(c)) return { tier: 'S', revival: false };
  if (/^drama$/.test(c)) return { tier: 'S', revival: false };
  if (/best (original )?score|outstanding (new )?score|outstanding music\b|outstanding lyrics|outstanding music in a play/.test(c)) return { tier: 'A+', revival: false };
  if (/best book|outstanding book/.test(c)) return { tier: 'A+', revival: false };
  if (/direction|director/.test(c)) return { tier: 'A', revival: false };
  if (/choreograph/.test(c)) return { tier: 'A', revival: false };
  if (/distinguished performance/.test(c)) return { tier: 'A', revival: false };
  if (/best (actor|actress) in a (play|musical)|outstanding (actor|actress) in a (play|musical)/.test(c)) return { tier: 'A', revival: false };
  if (/outstanding lead performance in a (play|musical)/.test(c)) return { tier: 'A', revival: false };
  if (/featured (actor|actress)/.test(c)) return { tier: 'B', revival: false };
  if (/outstanding featured performance in a (play|musical)/.test(c)) return { tier: 'B', revival: false };
  if (/orchestration/.test(c)) return { tier: 'B', revival: false };
  if (/ensemble/.test(c)) return { tier: 'B', revival: false };
  if (/scenic|set design/.test(c)) return { tier: 'C', revival: false };
  if (/costume/.test(c)) return { tier: 'C', revival: false };
  if (/lighting/.test(c)) return { tier: 'C', revival: false };
  if (/sound/.test(c)) return { tier: 'C', revival: false };
  return null;
}

const TIER_WEIGHTS = { S: 0, 'A+': 2.0, A: 1.5, B: 1.0, C: 0.5 };

const TRACKED = new Set(['2013-14','2014-15','2015-16','2016-17','2017-18','2018-19','2019-20','2021-22','2022-23','2023-24','2024-25']);

function computeWeightedNoms(entry, tonyCategory) {
  const matching = TONY_TO_PRECURSOR_CATEGORY[tonyCategory];
  if (!matching) return 0;
  let weightedNoms = 0;
  // Mirror data-tony-predictions.ts:computeAwardsScore — iterate union(wins,
  // nominatedFor) deduplicated per precursor. Tony stores wins ⊂ noms;
  // DD/OCC/DL store them DISJOINTLY (wins of non-top-cat live in wins[]
  // only). Iterating just nominatedFor under-counts precursor wins by ~75%.
  for (const src of ['dramaLeague', 'outerCriticsCircle', 'dramadesk']) {
    const node = entry[src];
    if (!node) continue;
    const wins = node.wins || [];
    const noms = node.nominatedFor || [];
    const matchCat = matching[src];
    const seen = new Set();
    for (const nomCat of [...wins, ...noms]) {
      if (nomCat === matchCat) continue;
      if (seen.has(nomCat)) continue;
      seen.add(nomCat);
      const cls = classifyCategory(nomCat);
      if (!cls) continue;
      weightedNoms += TIER_WEIGHTS[cls.tier];
    }
  }
  return weightedNoms;
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function main() {
  console.log(`Reading frozen snapshot: ${SNAPSHOT_PATH}`);
  const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
  const awards = JSON.parse(raw);

  const byCategory = {
    'best-musical': [],
    'best-play': [],
    'best-revival-musical': [],
    'best-revival-play': [],
  };
  const titleToKey = {
    'Best Musical': 'best-musical',
    'Best Play': 'best-play',
    'Best Revival of a Musical': 'best-revival-musical',
    'Best Revival of a Play': 'best-revival-play',
  };

  for (const [showId, data] of Object.entries(awards.shows || {})) {
    if (!data.tony || !TRACKED.has(data.tony.season)) continue;
    const wins = data.tony.wins || [];
    const noms = data.tony.nominatedFor || [];
    for (const tonyCat of Object.keys(titleToKey)) {
      if (!wins.includes(tonyCat) && !noms.includes(tonyCat)) continue;
      const w = computeWeightedNoms(data, tonyCat);
      byCategory[titleToKey[tonyCat]].push({ id: showId, season: data.tony.season, weightedNoms: w });
    }
  }

  const out = {
    snapshotSource: 'data/audit/tony-pre-tier-weights/awards.json.snapshot',
    derivedAt: new Date().toISOString(),
    formula: 'sum across DL+OCC+DD of PRECURSOR_TIER_NOM_WEIGHTS[classifyCategory(nomCat).tier], skipping matching top cat',
    percentile: 95,
    ceilings: {},
    diagnostics: {},
  };

  let totalNonzero = 0;
  for (const [catKey, shows] of Object.entries(byCategory)) {
    const values = shows.map(s => s.weightedNoms);
    const nonzero = values.filter(v => v > 0);
    totalNonzero += nonzero.length;
    out.ceilings[catKey] = percentile(values, 95);
    out.diagnostics[catKey] = {
      n: shows.length,
      nonzeroCount: nonzero.length,
      max: values.length ? Math.max(...values) : 0,
      median: percentile(values, 50),
      p95: percentile(values, 95),
      top3: [...shows].sort((a, b) => b.weightedNoms - a.weightedNoms).slice(0, 3),
    };
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2));
  console.log(`Wrote: ${OUTPUT_PATH}`);
  console.log(`\nCeilings (95th percentile weightedNoms):`);
  for (const [cat, ceiling] of Object.entries(out.ceilings)) {
    console.log(`  ${cat.padEnd(22)} ${ceiling.toFixed(1)}`);
  }

  if (totalNonzero === 0) {
    console.warn('\n⚠️  WARNING: All weightedNoms are 0 in the frozen snapshot.');
    console.warn('   This is expected if Sprint 2 backfill (per-category precursor noms)');
    console.warn('   has not run yet — the snapshot only has matching-top-cat in nominatedFor.');
    console.warn('   DO NOT copy these ceilings into NOMS_POOL_BY_CATEGORY until Sprint 2 lands.');
  } else {
    console.log(`\nTotal nonzero weightedNoms across all categories: ${totalNonzero}`);
    console.log('Eyeball ceilings above; copy into NOMS_POOL_BY_CATEGORY if reasonable.');
  }
}

main();
