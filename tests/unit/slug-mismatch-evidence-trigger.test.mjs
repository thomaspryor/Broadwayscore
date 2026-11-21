/**
 * BRO-7204 class guard, second pass. "Data quality: slug-mismatch lifetime
 * sweep" was filed 7 times in 30 days (BRO-4697/5438/5536/5693/6524/7121/7223)
 * because the digest row warned on EVERY new sweep key, and nearly every new
 * key is a freshly ingested review with a headline URL whose text cannot be
 * attributed: no evidence of contamination either way, so the card could only
 * be closed by yet another URL-shape special case. Pins:
 *  - urlNamesOtherShow (the contamination audit's canonical matcher): a URL
 *    naming another show is evidence; headline URLs, one-word and same-family
 *    titles are not;
 *  - end to end through the real runner + real row function: a new headline-
 *    URL hit does not warn; an evidence hit warns and STAYS open across runs
 *    (so it outlives the digest's 48h settle and 72h filing gates) until it
 *    leaves the sweep or 96h pass; a backlog key that later gains evidence
 *    opens; a pre-tracking snapshot's evidence keys are baseline;
 *  - snapshots without the evidence fields keep the old trigger.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const check = require('../../scripts/lib/opening-night-checks/slug-mismatch.check.js');
const { runLifetimeSweep, EVIDENCE_HOLD_HOURS } = require('../../scripts/lib/opening-night-checks/lifetime-sweep-runner.js');
const { lifetimeSweepRowResult } = require('../../scripts/lib/lifetime-sweep-row.js');

// The runner always writes under <repo>/data/audit; resolve it from this file, not cwd.
const AUDIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'audit');

const NINE = { id: '9-to-5-west-end-2019', title: '9 to 5 the Musical', slug: '9-to-5-the-musical' };
const APRIL = { id: 'your-lie-in-april-west-end-2024', title: 'Your Lie in April', slug: 'your-lie-in-april' };
const DOGMAN = { id: 'dog-man-the-musical-west-end-2026', title: 'Dog Man: The Musical', slug: 'dog-man-the-musical' };
const DOGMAN_BW = { id: 'dog-man-2024', title: 'Dog Man', slug: 'dog-man' };
const CHICAGO = { id: 'chicago-1996', title: 'Chicago', slug: 'chicago' };
const SHOWS = [NINE, APRIL, DOGMAN, DOGMAN_BW, CHICAGO];
const LATE = { id: 'harold-fry-west-end-2025', title: 'The Unlikely Pilgrimage of Harold Fry', slug: 'harold-fry' };

const HEADLINE = 'https://www.chicagotheatrereview.com/2023/11/a-can-of-worms/';
const HEADLINE2 = 'https://www.chicagotheatrereview.com/2024/04/finding-your-own-song/';
const NAMES_APRIL = 'https://www.allthatdazzles.co.uk/post/review-your-lie-in-april-the-musical-is-a-triumph';
const NAMES_FRY = 'https://www.standard.co.uk/culture/theatre/the-unlikely-pilgrimage-of-harold-fry-theatre-royal-review';

describe('urlNamesOtherShow (BRO-7204)', () => {
  it('a URL naming another show in shows.json is evidence', () => {
    assert.strictEqual(check.urlNamesOtherShow(NAMES_APRIL, NINE, SHOWS), 'Your Lie in April');
  });
  it('a headline URL naming no show is not evidence', () => {
    assert.strictEqual(check.urlNamesOtherShow(HEADLINE, NINE, SHOWS), null);
  });
  it('a one-word title in the path ("chicago") is not evidence', () => {
    assert.strictEqual(check.urlNamesOtherShow('https://x.com/2024/05/chicago-loves-this-play/', NINE, SHOWS), null);
  });
  it('same-family titles never count ("Dog Man" vs "Dog Man: The Musical")', () => {
    assert.strictEqual(check.urlNamesOtherShow('https://bww.com/Review-DOG-MAN-THE-MUSICAL-x', DOGMAN_BW, SHOWS), null);
  });
  it('without shows it is inert', () => {
    assert.strictEqual(check.urlNamesOtherShow(NAMES_APRIL, NINE, undefined), null);
  });
});

describe('lifetime sweep digest row: open evidence only (BRO-7204)', () => {
  let tmp; let snapName; let snapPath;
  const formatAge = (h) => `${Math.round(h)}h`;
  const ROW = { name: 'Data quality: slug-mismatch lifetime sweep', scriptName: 'audit-slug-mismatch-lifetime.js', stepName: 's', unit: 'cross-show URL mismatch(es)', formatAge };
  const T0 = Date.parse('2026-11-10T07:00:00Z');
  const H = 3600000;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-evidence-'));
    fs.mkdirSync(path.join(tmp, 'rt', NINE.id), { recursive: true });
    snapName = `test-bro7204-${process.pid}-${Date.now()}.json`;
    snapPath = path.join(AUDIT_DIR, snapName);
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(snapPath, { force: true });
  });

  function sweep(urls, nowMs, shows = SHOWS) {
    fs.writeFileSync(path.join(tmp, 'shows.json'), JSON.stringify({ shows }));
    fs.writeFileSync(path.join(tmp, 'reviews.json'), JSON.stringify({
      reviews: urls.map((url, i) => ({ showId: NINE.id, outletId: `o${i}`, criticName: 'c', url })),
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
        nowMs,
        argv: [`--review-texts-dir=${path.join(tmp, 'rt')}`, `--shows-path=${path.join(tmp, 'shows.json')}`, `--reviews-path=${path.join(tmp, 'reviews.json')}`],
      });
    } finally { console.log = origLog; }
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    return { snap, row: lifetimeSweepRowResult({ ...ROW, snap, ageHours: 1 }) };
  }

  it('a pre-tracking snapshot: its evidence keys are baseline, not news', () => {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.writeFileSync(snapPath, JSON.stringify({ violationKeys: [`${NINE.id}::${NAMES_APRIL}`] }));
    const { snap, row } = sweep([HEADLINE, NAMES_APRIL], T0);
    assert.strictEqual(snap.newActionableSinceLastRun, 0);
    assert.strictEqual(snap.openActionableCount, 0);
    assert.strictEqual(row.status, 'pass', row.message);
  });

  it('a NEW headline-URL hit is backlog: row passes', () => {
    const { snap, row } = sweep([HEADLINE, NAMES_APRIL, HEADLINE2], T0 + 24 * H);
    assert.strictEqual(snap.newSinceLastRun, 1);
    assert.strictEqual(snap.openActionableCount, 0);
    assert.strictEqual(row.status, 'pass', row.message);
    assert.match(row.message, /1 new hit\(s\) with no contamination evidence/);
  });

  it('a backlog key that later gains evidence (rival added to shows.json) opens and warns', () => {
    sweep([HEADLINE, NAMES_APRIL, HEADLINE2, NAMES_FRY], T0 + 48 * H);
    const { snap, row } = sweep([HEADLINE, NAMES_APRIL, HEADLINE2, NAMES_FRY], T0 + 72 * H, [...SHOWS, LATE]);
    assert.strictEqual(snap.newSinceLastRun, 0);
    assert.deepStrictEqual(snap.newActionableKeys, [`${NINE.id}::${NAMES_FRY}`]);
    assert.strictEqual(row.status, 'warn');
    assert.match(row.message, /^1 cross-show URL mismatch\(es\) with contamination evidence open/);
  });

  it('the evidence hit stays open on later runs (outlives the 48h settle + 72h filing gates)', () => {
    const { snap, row } = sweep([HEADLINE, NAMES_APRIL, HEADLINE2, NAMES_FRY], T0 + (72 + 80) * H, [...SHOWS, LATE]);
    assert.strictEqual(snap.newActionableSinceLastRun, 0);
    assert.strictEqual(row.status, 'warn');
  });

  it(`it closes once ${EVIDENCE_HOLD_HOURS}h pass`, () => {
    const { row } = sweep([HEADLINE, NAMES_APRIL, HEADLINE2, NAMES_FRY], T0 + (72 + EVIDENCE_HOLD_HOURS + 1) * H, [...SHOWS, LATE]);
    assert.strictEqual(row.status, 'pass', row.message);
  });

  it('a fresh evidence hit closes as soon as it leaves the sweep (flagged/fixed)', () => {
    const urlB = 'https://x.co.uk/review-your-lie-in-april-palladium';
    const t = T0 + 300 * H;
    assert.strictEqual(sweep([HEADLINE, urlB], t).row.status, 'warn');
    assert.strictEqual(sweep([HEADLINE], t + 24 * H).row.status, 'pass');
  });
});

describe('lifetimeSweepRowResult back-compat', () => {
  const base = { name: 'n', scriptName: 's.js', stepName: 'st', unit: 'u', formatAge: (h) => `${h}h` };
  it('a snapshot without the evidence fields keeps the newSinceLastRun trigger', () => {
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
