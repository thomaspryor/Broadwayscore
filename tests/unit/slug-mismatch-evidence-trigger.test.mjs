/**
 * BRO-7204 class guard, second pass. "Data quality: slug-mismatch lifetime
 * sweep" was filed 7 times in 30 days (BRO-4697/5438/5536/5693/6524/7121/7223)
 * because the digest row warned on EVERY new sweep key, and nearly every new
 * key is a freshly ingested review with a headline URL whose text cannot be
 * attributed: no evidence of contamination either way, so the card could only
 * be closed by yet another URL-shape special case. Pins:
 *  - urlNamesOtherShow: a URL naming another show's multi-word title is
 *    evidence; headline URLs, one-word titles and same-family titles are not;
 *  - end to end through the real runner + real row function: a new headline-
 *    URL hit no longer warns; a new hit whose URL names another show does;
 *  - snapshots without the evidence field keep the old trigger.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const check = require('../../scripts/lib/opening-night-checks/slug-mismatch.check.js');
const { runLifetimeSweep } = require('../../scripts/lib/opening-night-checks/lifetime-sweep-runner.js');
const { lifetimeSweepRowResult } = require('../../scripts/lib/lifetime-sweep-row.js');

const GODOT = { id: 'waiting-for-godot-2009', title: 'Waiting for Godot', slug: 'waiting-for-godot' };
const NINE = { id: '9-to-5-2009', title: '9 to 5', slug: '9-to-5' };
const DOGMAN = { id: 'dog-man-the-musical-west-end-2026', title: 'Dog Man: The Musical', slug: 'dog-man-the-musical' };
const DOGMAN_BW = { id: 'dog-man-2024', title: 'Dog Man', slug: 'dog-man' };
const CHICAGO = { id: 'chicago-1996', title: 'Chicago', slug: 'chicago' };
const SHOWS = [GODOT, NINE, DOGMAN, DOGMAN_BW, CHICAGO];

const HEADLINE = 'https://www.chicagotheatrereview.com/2023/11/a-can-of-worms/';
const NAMES_9TO5 = 'https://leisureblogs.chicagotribune.com/the_theater_loop/2009/04/dolly-parton-on-broadway-9-to-5.html';

describe('urlNamesOtherShow (BRO-7204)', () => {
  it('a URL naming another show in shows.json is evidence', () => {
    assert.strictEqual(check.urlNamesOtherShow(NAMES_9TO5, GODOT, SHOWS), '9 to 5');
  });
  it('a headline URL naming no show is not evidence', () => {
    assert.strictEqual(check.urlNamesOtherShow(HEADLINE, GODOT, SHOWS), null);
  });
  it('a one-word title in the path ("chicago") is not evidence', () => {
    assert.strictEqual(check.urlNamesOtherShow('https://x.com/2024/05/chicago-loves-this-play/', GODOT, SHOWS), null);
  });
  it('same-family titles never count ("Dog Man" vs "Dog Man: The Musical")', () => {
    assert.strictEqual(check.urlNamesOtherShow('https://bww.com/Review-DOG-MAN-THE-MUSICAL-x', DOGMAN_BW, SHOWS), null);
    assert.strictEqual(check.urlNamesOtherShow('https://x.com/dog-man-review', DOGMAN, SHOWS), null);
  });
  it('without shows it is inert', () => {
    assert.strictEqual(check.urlNamesOtherShow(NAMES_9TO5, GODOT, undefined), null);
  });
});

describe('lifetime sweep digest row warns only on new evidence (BRO-7204)', () => {
  let tmp; let snapName; let snapPath;
  const formatAge = (h) => `${Math.round(h)}h`;
  const ROW = { name: 'Data quality: slug-mismatch lifetime sweep', scriptName: 'audit-slug-mismatch-lifetime.js', stepName: 's', unit: 'cross-show URL mismatch(es)', formatAge };

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-evidence-'));
    fs.mkdirSync(path.join(tmp, 'rt', GODOT.id), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'shows.json'), JSON.stringify({ shows: SHOWS }));
    snapName = `test-bro7204-${process.pid}-${Date.now()}.json`;
    snapPath = path.join(process.cwd(), 'data', 'audit', snapName);
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(snapPath, { force: true });
  });

  function sweep(urls) {
    fs.writeFileSync(path.join(tmp, 'reviews.json'), JSON.stringify({
      reviews: urls.map((url, i) => ({ showId: GODOT.id, outletId: `o${i}`, criticName: 'c', url })),
    }));
    const origLog = console.log;
    console.log = () => {};
    try {
      runLifetimeSweep({
        checkModule: check,
        scriptName: 'audit-slug-mismatch-lifetime.js',
        taskRef: 'test',
        snapshotBasename: snapName,
        extractViolations: (r) => (r.details && r.details.mismatches) || [],
        violationKey: (showId, v) => (v.url ? `${showId}::${v.url}` : showId),
        needsShows: true,
        isActionable: check.isContaminationEvidence,
        argv: [`--review-texts-dir=${path.join(tmp, 'rt')}`, `--shows-path=${path.join(tmp, 'shows.json')}`, `--reviews-path=${path.join(tmp, 'reviews.json')}`],
      });
    } finally { console.log = origLog; }
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    return { snap, row: lifetimeSweepRowResult({ ...ROW, snap, ageHours: 1 }) };
  }

  it('baseline run, then a NEW headline-URL hit: backlog, row passes', () => {
    sweep([HEADLINE]);
    const { snap, row } = sweep([HEADLINE, 'https://www.chicagotheatrereview.com/2024/04/finding-your-own-song/']);
    assert.strictEqual(snap.newSinceLastRun, 1);
    assert.strictEqual(snap.newActionableSinceLastRun, 0);
    assert.strictEqual(row.status, 'pass', row.message);
    assert.match(row.message, /1 new hit\(s\) with no contamination evidence/);
  });

  it('a NEW hit whose URL names another show warns', () => {
    const { snap, row } = sweep([HEADLINE, 'https://www.chicagotheatrereview.com/2024/04/finding-your-own-song/', NAMES_9TO5]);
    assert.strictEqual(snap.newActionableSinceLastRun, 1);
    assert.deepStrictEqual(snap.newActionableKeys, [`${GODOT.id}::${NAMES_9TO5}`]);
    assert.strictEqual(row.status, 'warn');
    assert.match(row.message, /1 NEW cross-show URL mismatch\(es\) with contamination evidence/);
  });

  it('the same evidence hit does not warn again on the next run', () => {
    const { row } = sweep([HEADLINE, 'https://www.chicagotheatrereview.com/2024/04/finding-your-own-song/', NAMES_9TO5]);
    assert.strictEqual(row.status, 'pass');
  });
});

describe('lifetimeSweepRowResult back-compat', () => {
  const base = { name: 'n', scriptName: 's.js', stepName: 'st', unit: 'u', formatAge: (h) => `${h}h` };
  it('a snapshot without the evidence field keeps the newSinceLastRun trigger', () => {
    const row = lifetimeSweepRowResult({ ...base, ageHours: 2, snap: { newSinceLastRun: 3, totalViolations: 9, showsWithViolations: 4, scanned: 10 } });
    assert.strictEqual(row.status, 'warn');
    assert.match(row.message, /^3 NEW u since last run/);
  });
  it('missing snapshot warns, stale snapshot errors', () => {
    assert.strictEqual(lifetimeSweepRowResult({ ...base, ageHours: Infinity, snap: null }).status, 'warn');
    assert.strictEqual(lifetimeSweepRowResult({ ...base, ageHours: 49, snap: { newSinceLastRun: 0 } }).status, 'error');
    assert.strictEqual(lifetimeSweepRowResult({ ...base, ageHours: Infinity, snap: { newSinceLastRun: 0 } }).status, 'error');
  });
});
