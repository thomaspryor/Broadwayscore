// LIVE-DATA-LANE: reads data/shows.json and data/freshness-report.json (untracked core data), pins no specific show, only that the enrichers reach the shows the report flags. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
/**
 * BRO-7437 class guard, live half: a daily `--limit=N` enricher must actually
 * REACH the open shows the freshness report is flagging. See
 * enrichment-target-reach.test.mjs for the synthetic half and the full story
 * (a bare slice(0, 20) of a file-ordered, mostly-closed list reached ZERO of
 * the 38 flagged shows, every day, for a year).
 *
 * Assertions are over a whole MONTH of rotation, never "today".
 *
 * REVERT TEST: restore the bare `ordered.slice(0, limit)` in
 * selectSynopsisTargets and both tests below fail with 0 reached.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const { isLiveShow } = require(path.join(ROOT, 'scripts/lib/enrichment-targets.js'));
const { selectSynopsisTargets } = require(path.join(ROOT, 'scripts/lib/wikipedia-synopsis-match.js'));

const DAYS = Array.from({ length: 31 }, (_, i) => new Date(Date.UTC(2026, 0, i + 1)));

function readJson(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}


test('daily synopsis passes reach every flagged open show within a month', (t) => {
  const showsData = readJson('data/shows.json');
  const freshness = readJson('data/freshness-report.json');
  if (!showsData || !freshness) {
    t.skip('data/shows.json or data/freshness-report.json not present in this checkout');
    return;
  }
  const shows = Array.isArray(showsData) ? showsData : showsData.shows;
  if (!Array.isArray(shows) || !Array.isArray(freshness.dataQuality?.hasIssues)) {
    t.skip('unexpected data shape');
    return;
  }

  const byId = new Map(shows.map(s => [s.id, s]));
  // Only shows this enricher actually owns count: tours deliberately take
  // their Broadway parent's synopsis (BRO-4262) and are not candidates.
  const candidateIds = new Set(selectSynopsisTargets(shows, {}).map(s => s.id));
  const flagged = freshness.dataQuality.hasIssues
    .filter(s => s && s.id && (s.issues || []).some(i => i && i.severity === 'high' && i.type === 'missing_synopsis'))
    .map(s => byId.get(s.id))
    .filter(s => s && candidateIds.has(s.id));

  if (flagged.length === 0) {
    t.skip('no candidate show is currently flagged missing_synopsis');
    return;
  }

  // Exactly what .github/workflows/update-show-status.yml runs each day.
  const passes = [{ limit: 20 }, { category: 'west-end', limit: 10 }, { category: 'off-west-end', limit: 10 }];
  // NB: the claim is month-coverage, never per-day hit count. A per-day
  // `hits > 0` assertion would be a time bomb: once enrichment works and only
  // one or two flagged shows remain, each sits in the daily window about 8 days
  // in 31, so some day reaches zero and the test fails BECAUSE the data got
  // better (ship-check finding).
  const everReached = new Set();
  for (const now of DAYS) {
    const reached = new Set();
    for (const opts of passes) {
      for (const s of selectSynopsisTargets(shows, { ...opts, now })) reached.add(s.id);
    }
    for (const s of flagged) if (reached.has(s.id)) everReached.add(s.id);
  }

  const missed = flagged.filter(s => !everReached.has(s.id)).map(s => s.id);
  assert.deepEqual(
    missed,
    [],
    `the daily synopsis enricher never reaches ${missed.length} of ${flagged.length} flagged show(s) on any day `
    + 'of the month (BRO-7437: a bare slice() of a file-ordered, mostly-closed candidate list starves exactly the '
    + 'rows the health check reddens over, so the gap count can never fall and the card is refiled forever)',
  );
});

test('live synopsis targets are not starved by the historical tail', (t) => {
  const showsData = readJson('data/shows.json');
  if (!showsData) {
    t.skip('data/shows.json not present in this checkout');
    return;
  }
  const shows = Array.isArray(showsData) ? showsData : showsData.shows;
  const liveTargets = selectSynopsisTargets(shows, {}).filter(isLiveShow);
  if (liveTargets.length === 0) {
    t.skip('no live show currently needs a synopsis');
    return;
  }
  const liveIds = new Set(liveTargets.map(s => s.id));
  const reached = new Set();
  for (const now of DAYS) {
    for (const s of selectSynopsisTargets(shows, { limit: 20, now })) {
      if (liveIds.has(s.id)) reached.add(s.id);
    }
  }
  assert.equal(
    reached.size,
    liveTargets.length,
    `only ${reached.size} of ${liveTargets.length} live synopsis target(s) are reached in a month of daily runs`,
  );
});
