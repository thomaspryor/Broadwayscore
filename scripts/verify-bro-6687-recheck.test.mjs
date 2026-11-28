/**
 * verify-bro-6687-recheck.test.mjs — RECHECK-AFTER acceptance for BRO-6687
 * (slow-market review discovery, landed 2026-10-31). Asserts against LIVE
 * data, not fixtures: run by scripts/autonomous-acceptance-recheck.js once a
 * day of hourly gap-audit runs has used the round-robin ingest cap, the
 * slow-market rollup alert and the 48h slow-market re-audit tier. A red run
 * means a replayed opening still has a cited review that is not live.
 *
 * Baseline 2026-10-31 (pre-CI): The Heart FAIL (cititour reverify), In the
 * Heights PASS, Martin Guerre FAIL (london-now behind the ingest cap), Some
 * Woman PASS.
 *
 * timebomb-audit-exempt: dated RECHECK-AFTER probe of live cron output; the assertion is pinned to a real 2026-10 landing date a shifted clock cannot simulate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { gradeShow } = require('./slow-market-grade.js');
const { SLOW_MARKETS } = require('./lib/slow-market-gap.js');

const REPLAY = ['the-heart-off-broadway-2026', 'in-the-heights-off-broadway-2026', 'martin-guerre-west-end-2026', 'some-woman-west-end-2026'];
// land.js runs every changed *.test.mjs, so the cron-dependent checks skip
// until a day of gap-audit runs has had the change.
const PENDING = Date.now() < Date.parse('2026-11-01T12:00:00Z')
  ? 'waits for a day of gap-audit runs with the BRO-6687 changes' : false;

const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));

test('every replayed opening grades PASS: each cited review is live or legitimately excluded', { skip: PENDING }, () => {
  const audit = readJson('data', 'audit', 'show-review-gap.json');
  const reviews = readJson('data', 'reviews.json').reviews || [];
  const rows = new Map((audit.results || []).map((r) => [r.showId, r]));
  const failing = REPLAY.map((id) => ({ id, g: gradeShow(rows.get(id), reviews.filter((r) => r.showId === id).length) }))
    .filter(({ g }) => g.grade !== 'PASS')
    .map(({ id, g }) => `${id}: ${g.grade} (${g.notLive.join(', ')})`);
  assert.deepEqual(failing, [], `run node scripts/slow-market-grade.js --show=${REPLAY.join(',')}`);
});

test('the gap audit records slowMarketResidual for slow-market shows (phase 3 cadence is live)', { skip: PENDING }, () => {
  const checkpoint = readJson('data', 'audit', 'gap-audit-checkpoint.json');
  const shows = readJson('data', 'shows.json');
  const list = Array.isArray(shows) ? shows : shows.shows;
  const since = Date.parse('2026-10-31T06:00:00Z');
  const audited = list.filter((s) => SLOW_MARKETS.has(s.category) && checkpoint[s.id] && Date.parse(checkpoint[s.id].at) > since);
  assert.ok(audited.length > 0, 'no slow-market show audited since the landing');
  const missing = audited.filter((s) => typeof checkpoint[s.id].slowMarketResidual !== 'number').map((s) => s.id);
  assert.deepEqual(missing, []);
});
