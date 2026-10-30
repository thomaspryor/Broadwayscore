// BRO-6650: (S5-T1) the recorded rehearsal workflow's push paths cover every file in the lane code hash, so no
// lane-relevant merge leaves a stale record; (S5-T2) the pre-press-night freeze check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const { laneCodeFiles } = require('../../scripts/lib/opening-night-lane/rehearsal.js');
const { readPushPathsFrom, isCovered } = require('../../scripts/lib/test-yml-push-paths.js');
const { evaluateFreeze, findOverride } = require('../../scripts/lib/lane-code-freeze.js');
const { defaultEmbargoAt } = require('../../scripts/lib/press-night-record.js');

const WF = path.join(ROOT, '.github/workflows/lane-rehearsal-recorded.yml');
const rel = (f) => path.relative(ROOT, f);

test('recorded workflow push paths cover every lane-hash file', () => {
  const paths = readPushPathsFrom(WF);
  assert.ok(paths.includes('scripts/lib/**'), 'the first paths: block must be the push block');
  const uncovered = laneCodeFiles().map(rel).filter((f) => !isCovered(f, paths));
  assert.deepEqual(uncovered, [], `lane hash files not matched by lane-rehearsal-recorded.yml push paths: ${uncovered.join(', ')}`);
});

test('recorded fixtures and the record script trigger the workflow too', () => {
  const paths = readPushPathsFrom(WF);
  for (const f of ['scripts/lib/lane-recorded-nights/index.js', 'scripts/lib/lane-recorded-nights/a-few-good-men-2026.js', 'scripts/opening-night-lane-rehearse.js']) {
    assert.ok(isCovered(f, paths), f);
  }
});

const LANE = ['scripts/lib/opening-night-lane/driver.js', 'scripts/lib/aggregator-domains.js'];
const show = (id, market, openingDate, extra = {}) => ({ id, market, category: market === 'broadway' ? 'broadway' : 'west-end', openingDate, ...extra });
const SHOWS = [show('bway', 'broadway', '2026-11-08'), show('wend', 'west-end', '2026-11-08'), show('offb', 'broadway', '2026-11-16', { category: 'off-broadway' })];
const embargo = Date.parse(defaultEmbargoAt(SHOWS[0]));
const H = 3600000;
const run = (over) => evaluateFreeze({ changedFiles: ['scripts/lib/opening-night-lane/driver.js'], laneFiles: LANE, shows: SHOWS, nowMs: embargo - 47 * H, embargoAtFn: defaultEmbargoAt, ...over });

test('lane file change with a Broadway press night 47h out is flagged', () => {
  const r = run();
  assert.equal(r.status, 'flagged');
  assert.equal(r.nights[0].show, 'bway');
});

test('override with a written reason passes; a short reason does not', () => {
  assert.equal(run({ commitMessages: ['fix\n\nLANE-FREEZE-BYPASS: urgent scoring fix, rehearsal re-run planned\n'] }).status, 'overridden');
  assert.equal(run({ commitMessages: ['LANE-FREEZE-BYPASS: ok'] }).status, 'flagged');
  assert.equal(findOverride(['no trailer']), null);
});

test('window edges: 49h out clear, embargo +3h flagged, embargo +7h clear', () => {
  assert.equal(run({ nowMs: embargo - 49 * H }).status, 'clear');
  assert.equal(run({ nowMs: embargo + 3 * H }).status, 'flagged');
  assert.equal(run({ nowMs: embargo + 7 * H }).status, 'clear');
});

test('Off-Broadway counts, West End does not', () => {
  const offEmb = Date.parse(defaultEmbargoAt(SHOWS[2]));
  assert.equal(run({ nowMs: offEmb - 10 * H }).status, 'flagged');
  assert.equal(run({ shows: [SHOWS[1]] }).status, 'clear');
});

test('a change outside the lane hash is clear without reading shows', () => {
  assert.equal(run({ changedFiles: ['src/app/page.tsx'], shows: null }).status, 'clear');
});

test('missing shows.json is unknown, never clear', () => {
  assert.equal(run({ shows: null }).status, 'unknown');
});

test('deleted lane root file is flagged; deleted unrelated scripts/lib file is not', () => {
  assert.equal(run({ changedFiles: [], deletedFiles: ['scripts/lib/opening-night-lane/old.js'] }).status, 'flagged');
  assert.equal(run({ changedFiles: [], deletedFiles: ['scripts/lib/unrelated-thing.js'] }).status, 'clear');
});

test('a show with a bad openingDate is skipped, not fatal', () => {
  const r = run({ shows: [show('bad', 'broadway', 'garbage'), SHOWS[0]] });
  assert.equal(r.status, 'flagged');
  assert.deepEqual(r.skipped, ['bad']);
});

test('kill switch', () => {
  assert.equal(run({ disabled: true }).status, 'clear');
});

test('land.yml wires the check as an advisory step after core data', () => {
  const y = fs.readFileSync(path.join(ROOT, '.github/workflows/land.yml'), 'utf8');
  const i = y.indexOf('- name: Lane code freeze (advisory)');
  assert.ok(i > y.indexOf('- name: Checkout core data'));
  assert.match(y.slice(i, i + 2500), /continue-on-error: true/);
});
