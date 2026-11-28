// LIVE-DATA-LANE: reads data/shows.json (untracked core data) to prove the TS and JS gate agree on every show. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-7750 / BRO-8163: the site (src/config/scoring.ts) and the scripts
// (scripts/lib/should-hide-reviews.js + score-gate-rule.js) each carry a scoreGateArg. If they drift,
// the show page and the app/feeds disagree on whether a show has a score.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scoreGateArg as siteGate, scoreGateReason as siteReason } from '../../src/config/scoring';
import { serializeShowForClient } from '../../src/lib/serialize-show';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { scoreGateArg: scriptGate } = require('../../scripts/lib/should-hide-reviews.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { scoreGateReason: scriptReason, standingMinReviews, SHORT_RUN_DAYS } = require('../../scripts/lib/score-gate-rule.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const overrides = require('../../data/score-gate-overrides.json');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const curated: string[] = require('../../data/curated-historical-shows.json');

const showsPath = path.join(__dirname, '..', '..', 'data', 'shows.json');
const allShows: Array<Record<string, any>> = fs.existsSync(showsPath)
  ? (() => { const r = JSON.parse(fs.readFileSync(showsPath, 'utf8')); return Array.isArray(r) ? r : r.shows; })()
  : [];
const sh = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'musical', category: 'broadway', openingDate: '2026-11-20', closingDate: null, ...extra });

test('site scoreGateArg agrees with the scripts copy for every override and sample shows (by id)', () => {
  const ids: Array<string | null> = [...Object.keys(overrides.shows), curated[0], 'hamilton-2015', 'no-such-show', '', null];
  assert.ok(Object.keys(overrides.shows).length >= 1);
  for (const id of ids) assert.deepEqual(siteGate(id), scriptGate(id), `scoreGateArg(${JSON.stringify(id)})`);
  for (const id of Object.keys(overrides.shows)) assert.equal(typeof siteGate(id), 'number');
});

test('standing rule: special and short Broadway/West End runs get 3; long, open-ended and Off-Broadway short runs do not', () => {
  const cases: Array<[string, Record<string, unknown>, boolean | number]> = [
    ['special', sh('t-special', { type: 'special', category: 'off-broadway' }), 3],
    ['short Broadway run', sh('t-short', { closingDate: '2026-12-20' }), 3],
    ['short West End run', sh('t-we', { category: 'west-end', closingDate: '2026-12-20' }), 3],
    ['exactly 56 days', sh('t-56', { closingDate: '2027-01-15' }), 3],
    ['57 days', sh('t-57', { closingDate: '2027-01-16' }), false],
    ['open-ended', sh('t-open'), false],
    ['short Off-Broadway run', sh('t-ob', { category: 'off-broadway', closingDate: '2026-12-20' }), false],
  ];
  for (const [name, show, want] of cases) {
    assert.equal(siteGate(show as any), want, `site: ${name}`);
    assert.equal(scriptGate(show), want, `scripts: ${name}`);
  }
  assert.equal(SHORT_RUN_DAYS, 56);
});

test('precedence: an explicit entry beats the rule, keptMarketMinimum opts out, bare ids cannot trigger the rule', () => {
  const id = Object.keys(overrides.shows)[0];
  // Explicit minReviews wins even for a show the rule would also cover.
  assert.equal(siteGate({ id, type: 'special', category: 'broadway' } as any), overrides.shows[id].minReviews);
  assert.equal(scriptGate({ id, type: 'special', category: 'broadway' }), overrides.shows[id].minReviews);
  // keptMarketMinimum (with approvedBy) skips the rule.
  assert.equal(standingMinReviews(sh('kept', { type: 'special' }), { kept: { approvedBy: 'owner' } }), null);
  assert.equal(standingMinReviews(sh('kept', { type: 'special' }), { kept: {} }), 3);
  assert.equal(standingMinReviews(sh('kept', { type: 'special' }), { other: { approvedBy: 'owner' } }), 3);
  // A bare id has no run data, so the rule cannot apply (callers must pass the show).
  assert.equal(siteGate('t-special'), false);
});

test('classifier parity over every show in data/shows.json, and the serialized card shape keeps the gate fields', { skip: allShows.length === 0 }, () => {
  let covered = 0;
  for (const s of allShows) {
    assert.equal(siteReason(s as any), scriptReason(s), `reason(${s.id})`);
    assert.deepEqual(siteGate(s as any), scriptGate(s), `scoreGateArg(${s.id})`);
    if (siteReason(s as any)) covered++;
  }
  assert.ok(covered > 0, 'at least one show is covered by the rule');
  // The cards are fed serializeShowForClient output (slim); it must carry what the rule reads, or the badge and the feeds disagree.
  const sample = allShows.filter((s) => siteReason(s as any)).slice(0, 25);
  for (const s of sample) {
    const slim = serializeShowForClient({ ...(s as any), criticScore: null } as any) as any;
    assert.equal(siteGate(slim), siteGate(s as any), `serializeShowForClient keeps the gate inputs for ${s.id}`);
  }
});
