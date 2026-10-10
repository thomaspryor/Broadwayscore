// TESTS-VS-DERIVED-DATA-EXEMPT: structural; shows.json is read only to pick any show id/title/openingDate for fixtures, no fact is pinned
// BRO-4807 (epic BRO-4210, BRO-4782 wiring C): every writer that can SET an exclusion flag stands down for an
// opening-night lane review and ONLY for it. Each family runs the REAL guard function twice, once with a lane review
// (not flagged) and once with an ordinary review (flagged as today); a structural test fails when a script sets one of
// the flags without referencing laneBypasses or being registered / commented as lane-exempt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const tm = require('../../scripts/lib/opening-night-lane/trust-model.js');
const reg = require('../../scripts/lib/opening-night-lane/flagger-registry.js');
const writer = require('../../scripts/lib/review-file-writer.js');
const writeGuard = require('../../scripts/lib/review-write-guard.js');
const tourBackfill = require('../../scripts/lib/tour-backfill.js');

const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')).shows;
const SHOW = shows.find((s) => s.category === 'broadway' && s.openingDate && /^[a-z0-9-]+$/.test(s.id) && String(s.openingDate) >= '2025-06-01');
const NIGHT = String(SHOW.openingDate).slice(0, 10);
const stamp = (over = {}) => ({
  showId: SHOW.id,
  productionVerified: 'aggregator',
  openingNightLane: { show: SHOW.id, night: NIGHT, source: 'aggregator', seenAt: `${NIGHT}T22:00:00Z`, ...over },
});
const quiet = (fn) => {
  const log = console.warn; console.warn = () => {};
  try { return fn(); } finally { console.warn = log; }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bro4807-'));
const read = (r) => JSON.parse(fs.readFileSync(r.filepath, 'utf8'));
const body = `${'The performances were uneven but the staging was bold. '.repeat(20)}${SHOW.title}`;

// ------------------------------------------------------------ the contract

test('laneRevoked and a half-stamped review make every guard apply again', () => {
  const lane = stamp();
  for (const g of tm.LANE_BYPASSED_GUARDS) assert.equal(tm.laneBypasses(lane, g, { openingDate: NIGHT }), true, g);
  assert.equal(tm.isLaneReview({ ...lane, laneRevoked: true }), false, 'a revoked stamp is an ordinary review');
  assert.equal(tm.isLaneReview({ ...lane, productionVerified: undefined }), false);
  assert.equal(tm.isLaneReview({ showId: SHOW.id, openingNightLane: lane.openingNightLane }), false);
  assert.equal(tm.isLaneReview(lane, { openingDate: '2001-01-01' }), false, 'stamp for a different night');
});

// ------------------------------------------------------------ write-time guards (review-file-writer)

function write(input, fields) {
  const dir = tmp();
  const r = quiet(() => writer.createOrMergeReviewFile(SHOW.id, { source: 'serp', ...input, fields }, { reviewTextsDir: dir }));
  return { r, dir, data: r.filepath ? read(r) : null };
}

test('roundup flaggers (Guard E, roundupUrlSwap): lane review not flagged, ordinary review flagged', () => {
  const input = (n) => ({ outlet: 'BroadwayWorld', outletId: 'broadwayworld', criticName: `Critic ${n}`, url: `https://www.broadwayworld.com/article/Review-Roundup-${n}-Is-Here-20261018` });
  const lane = write(input('lane'), { fullText: body, ...stamp() });
  const ord = write(input('ord'), { fullText: body });
  assert.equal(lane.r.action, 'new');
  assert.equal(lane.data.isRoundupArticle, undefined);
  assert.equal(ord.data.isRoundupArticle, true);
});

test('unknown-critic URL-date flagger (Guard J, wrongProduction): lane review not flagged, ordinary review flagged', () => {
  const input = (n) => ({ outlet: 'The New York Times', outletId: 'nytimes', criticName: 'Unknown', url: `https://www.nytimes.com/2019/03/04/theater/${n}-review.html` });
  const lane = write(input('lane'), { fullText: body, ...stamp() });
  const ord = write(input('ord'), { fullText: body });
  assert.equal(lane.data.wrongProduction, undefined);
  assert.equal(ord.data.wrongProduction, true);
});

test('empty-unknown reject (Guard F, scraperGarbage): lane review is written, ordinary review is rejected', () => {
  const input = { outlet: 'Variety', outletId: 'variety', criticName: 'Unknown' };
  const lane = write(input, { ...stamp() });
  const ord = write(input, {});
  assert.equal(lane.r.action, 'new');
  assert.equal(ord.r.action, 'skipped');
  assert.match(ord.r.reason, /empty-unknown/);
});

test('a half-stamped review is an ordinary review for the writer guards', () => {
  const half = stamp(); delete half.productionVerified;
  const r = write({ outlet: 'The New York Times', outletId: 'nytimes', criticName: 'Unknown', url: 'https://www.nytimes.com/2019/03/04/theater/half-review.html' }, { fullText: body, ...half });
  assert.equal(r.data.wrongProduction, true);
});

// ------------------------------------------------------------ write guard (review-write-guard)

test('write-guard wrongShow stamp (BRO-4383, wrongProduction): lane review not flagged, ordinary review flagged', () => {
  const dir = tmp();
  const put = (name, extra) => {
    const showDir = path.join(dir, SHOW.id); fs.mkdirSync(showDir, { recursive: true });
    const fp = path.join(showDir, `nytimes--${name}.json`);
    quiet(() => writeGuard.safeWriteReview(fp, {
      showId: SHOW.id, outletId: 'nytimes', criticName: name, url: `https://www.nytimes.com/${name}.html`,
      fullText: 'Lorem ipsum dolor sit amet consectetur. '.repeat(60), ...extra,
    }));
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  };
  assert.equal(put('lane', stamp()).wrongShow, undefined);
  assert.equal(put('ord', {}).wrongShow, true);
});

// ------------------------------------------------------------ tour integrity flagger (tour-backfill)

test('tour integrity flag (tourCrossMarket): lane review not flagged, ordinary review flagged', () => {
  const row = { reason: 'UK production reviewed, not the North American tour' };
  const lane = tourBackfill.applyIntegrityFlag({ ...stamp() }, row);
  const ord = tourBackfill.applyIntegrityFlag({ showId: SHOW.id }, row);
  assert.equal(lane.wrongProduction, undefined);
  assert.equal(ord.wrongProduction, true);
});

// ------------------------------------------------------------ structural: no unwired flagger can land

const writers = reg.findFlagWriters(ROOT);

test('the scanner sees real setters and ignores comments and strings', () => {
  const src = [
    'data.wrongProduction = true;',
    'const x = { isNonReview: true };',
    '// data.wrongShow = true;',
    "console.log('wrongShow=true: 3');",
    'if (d.wrongShow === true) {}',
    '/* d.isRoundupArticle = true;',
    '   still a comment wrongProduction = true */',
  ].join('\n');
  assert.deepEqual(reg.flagWriteLines(src), [1, 2]);
});

test('every script that sets wrongProduction / wrongShow / isNonReview / isRoundupArticle = true references laneBypasses or is lane-exempt', () => {
  const unaccounted = writers.filter((w) => !w.wired && !w.exemptComment && !reg.LANE_EXEMPT[w.file]);
  assert.deepEqual(unaccounted.map((w) => `${w.file}:${w.lines.slice(0, 3).join(',')}`), [],
    'wire laneBypasses(review, guardName) into the writer, or register it in flagger-registry.js LANE_EXEMPT with a reason (or add a "lane-exempt: <reason>" comment)');
});

test('the exemption registry has no stale entries and no entry that is also wired', () => {
  const byFile = new Map(writers.map((w) => [w.file, w]));
  for (const f of Object.keys(reg.LANE_EXEMPT)) {
    assert.ok(byFile.has(f), `${f} no longer sets a flag: remove it from LANE_EXEMPT`);
    assert.equal(byFile.get(f).wired, false, `${f} references laneBypasses: remove it from LANE_EXEMPT`);
    assert.ok(reg.LANE_EXEMPT[f].reason.length > 20);
  }
});

test('"unscheduled" exemptions really are not run by any workflow', () => {
  const wfDir = path.join(ROOT, '.github/workflows');
  const text = fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => fs.readFileSync(path.join(wfDir, f), 'utf8')).join('\n');
  const scheduled = Object.entries(reg.LANE_EXEMPT)
    .filter(([, v]) => v.kind === 'unscheduled')
    .filter(([f]) => text.includes(f))
    .map(([f]) => f);
  assert.deepEqual(scheduled, [], 'a workflow runs these: wire laneBypasses into them');
});

test('every guard name passed to laneBypasses/laneHolds/laneHeld is a known lane guard (a typo throws at runtime)', () => {
  const bad = [];
  for (const w of writers.filter((x) => x.wired)) {
    const src = fs.readFileSync(path.join(ROOT, w.file), 'utf8');
    for (const m of src.matchAll(/\b(?:laneBypasses|laneHolds|laneHeld|laneOk)\(\s*(?:[\w.$]+,\s*)?'([A-Za-z]+)'/g)) {
      if (!tm.LANE_BYPASSED_GUARDS.includes(m[1])) bad.push(`${w.file}: ${m[1]}`);
    }
    assert.ok(/\blane(?:Bypasses|Holds|Held|Ok)\(/.test(src), `${w.file} mentions laneBypasses but never calls it`);
  }
  assert.deepEqual(bad, []);
});

test('in a wired file every flag write sits under a lane call or a "lane-guarded:" note (one wired site cannot hide the rest)', () => {
  const sites = writers.filter((w) => w.wired).flatMap((w) => w.unguarded.map((n) => `${w.file}:${n}`));
  assert.deepEqual(sites, [],
    `no laneBypasses/laneHolds/laneHeld within ${reg.SITE_WINDOW} lines above these writes: guard them, or add a "// lane-guarded: <where>" comment on or just above the line`);
});
