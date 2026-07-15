#!/usr/bin/env node
/**
 * Audit data/commercial.json for wrong-source LLM-extraction contamination.
 *
 * Background: scripts/update-commercial-data.js gathers from Reddit grosses
 * threads + trade press (Deadline, Variety, Broadway Journal) and feeds the
 * text to Claude Sonnet to propose field updates. If the scrape returns a
 * different show's gross/capitalization (similar title, wrong year, generic
 * keyword in a roundup article), the LLM dutifully writes those numbers to
 * the wrong commercial record. This audit catches the impossible-physics and
 * internal-contradiction signals that fall out of such misroutes.
 *
 * Companion to scripts/audit-cast-contamination.js (the cast-data version of
 * the same wrong-source class). See Notion 36a637c5-416f-81b7-a72b-f7e0dfbb24fc.
 *
 * Usage:
 *   node scripts/audit-commercial-contamination.js          # human-readable
 *   node scripts/audit-commercial-contamination.js --json   # machine-readable
 *
 * Signal severity:
 *   fail — count toward nonzero exit; ship-blocking
 *   warn — printed but doesn't fail CI by default
 *
 * Signals:
 *   WEEKLY_GT_CAP            (fail) — weeklyRunningCost > capitalization (impossible)
 *   DESIG_RECOUPED_CONTRA    (fail) — recouped:true with "Flop"/"Fizzle"
 *                                       or recouped:false with "Miracle"/"Windfall"
 *   CAP_OUTLIER              (fail) — capitalization < $100k or > $100M
 *   WEEKLY_OUTLIER           (fail) — weeklyRunningCost < $20k or > $2M
 *   CATEGORY_TYPE_MISMATCH   (warn) — modelCategory musical/play disagrees with shows.json type
 *   SHOW_NOT_IN_DB           (warn) — key doesn't resolve to any shows.json id
 *                                       (prefix-match aware for shorthand commercial keys)
 *   OUT_OF_MARKET_SCOPE      (warn) — resolved show is Off-Broadway/West End; commercial
 *                                       research is Broadway-only (scripts/lib/commercial-scope.js)
 *
 * Thresholds chosen against live data (2026-05-24, 183 commercial records):
 *   - Floor/ceiling produce zero baseline hits with margin (live cap range
 *     $2.25M–$68M, weekly range $250k–$1.5M).
 *   - Designation/recoupment contradiction has zero live hits.
 *   - SHOW_NOT_IN_DB is warn-only so adding new commercial rows ahead of
 *     shows-list updates doesn't break CI.
 */

const fs = require('fs');
const path = require('path');
const { isCommercialScope, resolveScopeShow } = require('./lib/commercial-scope');

const ROOT = path.join(__dirname, '..');
const COMMERCIAL_FILE = path.join(ROOT, 'data', 'commercial.json');
const SHOWS_FILE = path.join(ROOT, 'data', 'shows.json');

const FAIL_SIGNALS = new Set([
  'WEEKLY_GT_CAP',
  'DESIG_RECOUPED_CONTRA',
  'CAP_OUTLIER',
  'WEEKLY_OUTLIER',
]);

function loadShows() {
  try {
    const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf-8'));
    return data.shows || [];
  } catch {
    return null;
  }
}

// Commercial.json keys are often shorthand ("hamilton") vs shows.json's
// canonical id ("hamilton-2015"). Delegate exact-id / exact-slug / stripped
// -YYYY resolution to the shared resolveScopeShow() (scripts/lib/
// commercial-scope.js — also used by the research pipeline, so the two
// stay in sync) and only add the "key startsWith id-" shorthand fallback
// that resolveScopeShow doesn't cover (e.g. "hamilton" -> "hamilton-2015",
// which has no bare -YYYY suffix on the key to strip).
function resolveShow(key, shows, showsBySlug) {
  const viaShared = resolveScopeShow(showsBySlug, key);
  if (viaShared) return viaShared;
  const cands = shows.filter(s => s.id.startsWith(key + '-'));
  return cands[0] || null;
}

function audit() {
  const shows = loadShows();
  const showsBySlug = {};
  if (shows) {
    for (const s of shows) {
      if (s.id) showsBySlug[s.id] = s;
      if (s.slug) showsBySlug[s.slug] = s;
    }
  }
  const raw = JSON.parse(fs.readFileSync(COMMERCIAL_FILE, 'utf-8'));
  const showsMap = raw.shows || {};
  const issues = [];

  for (const [key, x] of Object.entries(showsMap)) {
    if (!x || typeof x !== 'object') continue;

    const flags = [];

    // WEEKLY_GT_CAP — physically impossible (weekly burn exceeds total raise)
    if (x.weeklyRunningCost > 0 && x.capitalization > 0
        && x.weeklyRunningCost > x.capitalization) {
      flags.push(`WEEKLY_GT_CAP:wkly=${x.weeklyRunningCost},cap=${x.capitalization}`);
    }

    // DESIG_RECOUPED_CONTRA — recoupment status disagrees with designation
    if (x.recouped === true && (x.designation === 'Flop' || x.designation === 'Fizzle')) {
      flags.push(`DESIG_RECOUPED_CONTRA:${x.designation}+recouped`);
    }
    if (x.recouped === false && (x.designation === 'Miracle' || x.designation === 'Windfall')) {
      flags.push(`DESIG_RECOUPED_CONTRA:${x.designation}+notRecouped`);
    }

    // CAP_OUTLIER — outside plausible range for a Broadway capitalisation
    if (typeof x.capitalization === 'number' && x.capitalization > 0) {
      if (x.capitalization < 100_000 || x.capitalization > 100_000_000) {
        flags.push(`CAP_OUTLIER:${x.capitalization}`);
      }
    }

    // WEEKLY_OUTLIER — outside plausible range for weekly running cost
    if (typeof x.weeklyRunningCost === 'number' && x.weeklyRunningCost > 0) {
      if (x.weeklyRunningCost < 20_000 || x.weeklyRunningCost > 2_000_000) {
        flags.push(`WEEKLY_OUTLIER:${x.weeklyRunningCost}`);
      }
    }

    let resolvedShow = null;
    if (shows) {
      resolvedShow = resolveShow(key, shows, showsBySlug);
      if (!resolvedShow) flags.push('SHOW_NOT_IN_DB');
    }

    // OUT_OF_MARKET_SCOPE — commercial data is Broadway-only; OB/WE entries
    // leaked via `market`-based queue filters (2026-07-14, 28 entries purged).
    if (resolvedShow && !isCommercialScope(resolvedShow)) {
      flags.push(`OUT_OF_MARKET_SCOPE:${resolvedShow.category}`);
    }

    // CATEGORY_TYPE_MISMATCH — only flag the strict musical/play contradiction;
    // hybrids like "play-with-music" are deliberately not flagged.
    if (resolvedShow && x.modelCategory && resolvedShow.type) {
      const mc = x.modelCategory;
      const st = resolvedShow.type;
      if ((mc === 'musical' && st === 'play') || (mc === 'play' && st === 'musical')) {
        flags.push(`CATEGORY_TYPE_MISMATCH:${mc}_vs_${st}`);
      }
    }

    if (flags.length > 0) {
      const hasFail = flags.some(f => FAIL_SIGNALS.has(f.split(':')[0]));
      issues.push({
        key,
        resolvedId: resolvedShow ? resolvedShow.id : null,
        severity: hasFail ? 'fail' : 'warn',
        flags,
      });
    }
  }

  return issues.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'fail' ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
}

function main() {
  const issues = audit();
  const json = process.argv.includes('--json');
  const strict = process.argv.includes('--strict');
  // --gate: per-push trunk catastrophe floor (test.yml) — blocks only on the
  // impossible/contradictory FAIL class via the pure scripts/lib/commercial-
  // contamination-gate.js (CLAUDE.md §15). Warns (forthcoming shows, category
  // mismatch) ride the digest. Full --strict runs daily in check-corpus-drift.yml.
  const gate = process.argv.includes('--gate');

  if (json) {
    process.stdout.write(JSON.stringify(issues, null, 2) + '\n');
  } else {
    const fails = issues.filter(i => i.severity === 'fail');
    const warns = issues.filter(i => i.severity === 'warn');
    console.log(`[audit-commercial-contamination] ${fails.length} fail, ${warns.length} warn\n`);
    for (const i of issues) {
      console.log(`  [${i.severity}] ${i.key}${i.resolvedId && i.resolvedId !== i.key ? ` (→ ${i.resolvedId})` : ''}`);
      console.log(`     flags: ${i.flags.join(', ')}`);
    }
  }

  const fails = issues.filter(i => i.severity === 'fail').length;
  const warns = issues.filter(i => i.severity === 'warn').length;

  if (gate) {
    // Fail LOUD if the source-of-truth is absent: loadShows() swallows a missing
    // data/shows.json to null, suppressing SHOW_NOT_IN_DB/CATEGORY_TYPE_MISMATCH.
    // (commercial.json missing already throws ENOENT in audit() → exit 1.)
    if (loadShows() === null) {
      console.error('\n❌ GATE: data/shows.json missing or unparseable — cannot run the commercial contamination gate.');
      process.exit(1);
    }
    const { shouldBlockCommercialContaminationGate } = require('./lib/commercial-contamination-gate');
    if (shouldBlockCommercialContaminationGate({ gateHits: fails })) {
      console.error(`\n❌ GATE: ${fails} commercial record(s) with impossible/contradictory physics (weekly>cap, recoupment contradiction, cap/weekly outlier).`);
      process.exitCode = 1;
    } else {
      console.log(`\n✓ GATE: no impossible-physics commercial records; warns surfaced in digest.`);
    }
    return;
  }

  if (fails > 0 || (strict && warns > 0)) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { audit, FAIL_SIGNALS };
