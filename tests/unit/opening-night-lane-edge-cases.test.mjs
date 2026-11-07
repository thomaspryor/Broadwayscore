// BRO-5201 S4-T5: the edge cases of a real night, through the production wiring.
// - A disarmed lane: buildRealLaneDeps with no recorded rehearsal (or only a synthetic one) refuses before any lease
//   work and pages why. Nothing is claimed, so the regular pipeline covers the night.
// - An aggregator whose roundup parses to no review on a known outlet: the night still runs, the adapter's error is in
//   the run's errors (named, never silent). The grade counts it as a source error, not a lane failure, and still fails
//   same-night completeness on the review only that roundup cited.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const driver = require('../../scripts/lib/opening-night-lane/driver.js');
const store = require('../../scripts/lib/opening-night-lane/lease-store.js');
const rehearsal = require('../../scripts/lib/opening-night-lane/rehearsal.js');
const afgm = require('../../scripts/lib/lane-recorded-nights/a-few-good-men-2026.js');

const SHOW = { id: 'disarmed-show-2026', title: 'Disarmed Show', openingDate: '2026-11-08', category: 'broadway' };
const NIGHT = '2026-11-08';

async function runDisarmed(t, recordFile) {
  const claims = [];
  t.mock.method(store, 'claim', async (...args) => { claims.push(args); return { ok: true }; });
  const pages = [];
  const deps = driver.buildRealLaneDeps({
    show: SHOW, night: NIGHT, openingDate: NIGHT, holder: 'test', repoDir: os.tmpdir(), coreDir: os.tmpdir(), recordFile,
    env: { ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: 'test', LANE_STANDDOWN: '' },
    routeAlert: async (opts) => { pages.push(opts); }, ScorerClass: class {},
  });
  let ran = 0;
  const out = await driver.runProductionLane({ show: SHOW, night: NIGHT, holder: 'test', deps: { ...deps, standdown: async () => null, runNight: async () => { ran++; return {}; } } });
  return { out, claims, pages, ran };
}

test('disarmed: no recorded rehearsal record refuses through the real deps, pages why, and claims nothing', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5201-disarmed-'));
  try {
    const { out, claims, pages, ran } = await runDisarmed(t, path.join(dir, 'lane-rehearsal-recorded.json'));
    assert.equal(out.exit, 3);
    assert.equal(out.reason, 'not-armed:no-rehearsal-record');
    assert.equal(claims.length, 0, 'no lease is claimed');
    assert.equal(ran, 0, 'the night never runs');
    assert.equal(pages.length, 1);
    assert.match(pages[0].title, /not armed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('disarmed: a passing synthetic rehearsal never arms a real night (no-recorded-rehearsal)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5201-disarmed-'));
  try {
    const recordFile = path.join(dir, 'lane-rehearsal-recorded.json');
    const at = new Date().toISOString();
    fs.writeFileSync(recordFile, JSON.stringify({ at, pass: true, kind: 'synthetic', laneHash: rehearsal.laneCodeHash(), checked: 35, failures: [] }));
    const { out, claims } = await runDisarmed(t, recordFile);
    assert.equal(out.reason, 'not-armed:no-recorded-rehearsal');
    assert.equal(claims.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('zero links: a BWW roundup with only deal and podcast cards is a named source error, and the grade shows what it cost', async () => {
  const cardsOnly = afgm.bwwPage.replace(/<div class="disnep-area">[\s\S]*?<\/div>/, '');
  const r = await afgm.replay({ site: true, bwwLayout: cardsOnly });
  const bww = r.errors.filter((e) => e.adapter === 'bww-roundup');
  assert.ok(bww.length > 0, `errors: ${JSON.stringify(r.errors)}`);
  // The runner keeps the first 200 characters of an adapter error, which still names the page and the link count.
  assert.match(bww[0].error, /^bww-roundup: roundup https:\/\/www\.broadwayworld\.com\/.* parsed to 1 cited link/);
  assert.ok(r.graded.sourceErrors.some((e) => e.adapter === 'bww-roundup'), 'graded as a source error');
  assert.deepEqual(r.graded.runProblems, [], 'a source error alone is not a lane failure');
  // What the broken source cost is graded, not hidden: WSJ is cited only by that roundup, so it never went live and
  // same-night completeness fails on it (the full night, with the roundup readable, grades PASS).
  assert.equal(r.live.length, 21);
  assert.equal(r.graded.sameNight.status, 'fail');
  assert.match(r.graded.sameNight.detail, /not live at \+2h: wsj\b/);
});
