// BRO-4098: triage-review-gap.js must not count another production's file as
// "ingested". Runs the real CLI against a fixture review-texts dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isOtherProductionFile, isPreRunFile } = require('./lib/review-gap-triage.js');
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'triage-review-gap.js');
const SHOW = 'fixture-show-west-end-2026';
const show = { id: SHOW, title: 'Fixture Show', previewsStartDate: '2026-09-01', openingDate: '2026-09-10', market: 'west-end' };

function run(files, outlet = 'Fixture Outlet', url = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-gap-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'shows.json'), JSON.stringify({ shows: [show] }));
  const rt = path.join(root, 'review-texts');
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(rt, rel)), { recursive: true });
    fs.writeFileSync(path.join(rt, rel), JSON.stringify(data));
  }
  fs.mkdirSync(rt, { recursive: true });
  const out = execFileSync('node', [CLI, `--show=${SHOW}`, `--outlet=${outlet}`, ...(url ? [`--url=${url}`] : []), '--json'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, REVIEW_TEXTS_DIR: rt, BSC_DATA_REPO: path.join(root, 'no-data-repo') },
  });
  fs.rmSync(root, { recursive: true, force: true });
  return JSON.parse(out);
}

const base = { showId: SHOW, outletId: 'fixture-outlet', outlet: 'Fixture Outlet', criticName: 'A Critic', fullText: 'x'.repeat(2000), isFullReview: true, contentTier: 'complete' };

test('only file is wrongProduction (older production) -> true-missed-discovery', () => {
  const r = run({ [`${SHOW}/fixture-outlet--a-critic.json`]: { ...base, publishDate: '2016-05-01', wrongProduction: true } });
  assert.equal(r.state, 'true-missed-discovery');
  assert.equal(r.justifiesUrlResolution, true);
  assert.equal(r.signals.reviewTexts.otherProductionPaths.length, 1);
});

test('wrongShow file dated before previews -> true-missed-discovery', () => {
  const r = run({ [`${SHOW}/fixture-outlet--a-critic.json`]: { ...base, publishDate: '2019-01-01', wrongShow: true } });
  assert.equal(r.state, 'true-missed-discovery');
});

test('only file is _pending dated before previewsStartDate -> true-missed-discovery', () => {
  const r = run({ [`_pending/${SHOW}/fixture-outlet--418ce4a5.json`]: { ...base, criticName: 'Unknown', publishDate: '2018-03-22', pendingReason: 'no-byline', fullText: null, contentTier: 'stub' } });
  assert.equal(r.state, 'true-missed-discovery');
});

test('_pending stub skipped as outside production window (no date) -> true-missed-discovery', () => {
  const r = run({ [`_pending/${SHOW}/fixture-outlet--418ce4a5.json`]: { ...base, publishDate: null, fullText: null, contentTier: 'stub', promoteSkippedReason: "article published 2018-03-22 is outside this production's window — earlier/later production of the same title" } });
  assert.equal(r.state, 'true-missed-discovery');
});

test('wrongProduction file dated inside the current run stays ingested-but-excluded (likely false-positive flag)', () => {
  const r = run({ [`${SHOW}/fixture-outlet--a-critic.json`]: { ...base, publishDate: '2026-09-11', wrongProduction: true } });
  assert.equal(r.state, 'ingested-but-excluded');
});

test('other-production file does not mask a valid current-production file', () => {
  const r = run({
    [`${SHOW}/fixture-outlet--old.json`]: { ...base, criticName: 'Old', publishDate: '2016-05-01', wrongProduction: true },
    [`${SHOW}/fixture-outlet--new.json`]: { ...base, criticName: 'New', publishDate: '2026-09-11' },
  });
  assert.equal(r.state, 'in-pipeline-awaiting-deploy');
});

test('undated wrongProduction file stays ingested-but-excluded (unknown date is never other-production)', () => {
  const r = run({ [`${SHOW}/fixture-outlet--a-critic.json`]: { ...base, publishDate: null, wrongProduction: true } });
  assert.equal(r.state, 'ingested-but-excluded');
});

test('isOtherProductionFile: no previewsStartDate, priorRuns, unreadable', () => {
  const old = { publishDate: '2016-05-01' };
  assert.equal(isOtherProductionFile({ data: old, pending: true }, { openingDate: '2026-09-10' }, null), false);
  assert.equal(isOtherProductionFile({ data: old, pending: true }, show, null), true);
  const withPrior = { ...show, priorRuns: [{ openingDate: '2016-04-01', closingDate: '2016-09-01' }] };
  assert.equal(isOtherProductionFile({ data: old, pending: true }, withPrior, null), false);
  assert.equal(isOtherProductionFile({ data: null, pending: true }, show, null), false);
  assert.equal(isOtherProductionFile({ data: { publishDate: '2026-09-09' }, pending: true }, { openingDate: '2026-09-10' }, null), false);
});

test('isOtherProductionFile: in-window _pending file is current', () => {
  assert.equal(isOtherProductionFile({ data: { publishDate: '2026-09-11' }, pending: true }, show, null), false);
  assert.equal(isOtherProductionFile({ data: null, pending: true }, show, null), false);
});

test('isOtherProductionFile: stale skip stamp loses to corrected in-window date; human clear wins', () => {
  const stamp = "article published 2018-03-22 is outside this production's window";
  assert.equal(isOtherProductionFile({ data: { publishDate: '2026-09-11', promoteSkippedReason: stamp }, pending: true }, show, null), false);
  assert.equal(isOtherProductionFile({ data: { publishDate: null, promoteSkippedReason: stamp }, pending: true }, show, null), true);
  assert.equal(isOtherProductionFile({ data: { publishDate: '2016-05-01', wrongProductionManualClear: true }, pending: true }, show, null), false);
  const tour = { ...show, tourLegs: [{ startDate: '2026-05-01', endDate: '2026-08-01' }] };
  assert.equal(isOtherProductionFile({ data: { publishDate: '2026-06-01' }, pending: true }, tour, null), false);
});

// BRO-4475: outlet-only match on an unrelated file (BWW forum thread) must not mask the real review.
test('--url: same-outlet file with a DIFFERENT url (wrongShow thread) -> true-missed-discovery, file ignored', () => {
  const r = run({ [`${SHOW}/fixture-outlet--a-critic.json`]: { ...base, publishDate: '2026-09-12', wrongShow: true, url: 'https://fixture.example/forum/thread-1' } },
    'Fixture Outlet', 'https://fixture.example/review/real-review');
  assert.equal(r.state, 'true-missed-discovery');
  assert.equal(r.matchedBy, 'url');
  assert.equal(r.outletOnlyIgnoredPaths.length, 1);
});

test('--url: file whose url matches (www/slash/query-tracking variance) is matched by URL', () => {
  const r = run({ [`${SHOW}/fixture-outlet--a-critic.json`]: { ...base, publishDate: '2026-09-12', url: 'https://www.fixture.example/review/real-review/' } },
    'Fixture Outlet', 'http://fixture.example/review/real-review');
  assert.equal(r.state, 'in-pipeline-awaiting-deploy');
  assert.equal(r.signals.reviewTexts.candidateCount, 1);
});

test('no --url: falls back to outlet matching (unchanged)', () => {
  const r = run({ [`${SHOW}/fixture-outlet--a-critic.json`]: { ...base, publishDate: '2026-09-12', url: 'https://fixture.example/forum/thread-1' } });
  assert.equal(r.matchedBy, 'outlet');
  assert.equal(r.state, 'in-pipeline-awaiting-deploy');
});

test('--url: same review with a stray tracking query string still matches (not a false missed-discovery)', () => {
  const r = run({ [`${SHOW}/fixture-outlet--a-critic.json`]: { ...base, publishDate: '2026-09-12', url: 'https://fixture.example/review/real-review?foo=bar' } },
    'Fixture Outlet', 'https://fixture.example/review/real-review');
  assert.equal(r.state, 'in-pipeline-awaiting-deploy');
});

test('--url: _pending strand file with no url stays a candidate (never hidden)', () => {
  const r = run({ [`_pending/${SHOW}/fixture-outlet--418ce4a5.json`]: { ...base, criticName: 'Unknown', publishDate: '2026-09-12', fullText: null, contentTier: 'stub', url: undefined } },
    'Fixture Outlet', 'https://fixture.example/review/real-review');
  assert.notEqual(r.state, 'true-missed-discovery');
  assert.equal(r.signals.reviewTexts.candidateCount, 1);
  assert.equal(r.signals.reviewTexts.anyPendingByline, true);
});

// BRO-4899: a pre-previews same-outlet file (interview) must not mask the real review.
test('pre-previews interview alone -> true-missed-discovery (not covering the outlet)', () => {
  const r = run({ [`${SHOW}/fixture-outlet--an-interviewer.json`]: { ...base, publishDate: '2026-08-20' } });
  assert.equal(r.state, 'true-missed-discovery');
});

test('pre-previews interview + in-window review -> reports only the review file', () => {
  const r = run({
    [`${SHOW}/fixture-outlet--an-interviewer.json`]: { ...base, publishDate: '2026-08-20' },
    [`${SHOW}/fixture-outlet--a-critic.json`]: { ...base, publishDate: '2026-09-10' },
  });
  assert.equal(r.state, 'in-pipeline-awaiting-deploy');
  assert.deepEqual(r.signals.reviewTexts.paths.map((p) => path.basename(p)), ['fixture-outlet--a-critic.json']);
});

test('isPreRunFile: prior run, human-reviewed, undated are exempt', () => {
  const f = (d, extra = {}) => ({ data: { publishDate: d, ...extra } });
  assert.equal(isPreRunFile(f('2026-08-20'), show), true);
  assert.equal(isPreRunFile(f('2026-09-01'), show), false);
  assert.equal(isPreRunFile(f(null), show), false);
  assert.equal(isPreRunFile(f('2026-08-20', { humanReviewScore: 70 }), show), false);
  assert.equal(isPreRunFile(f('2026-08-20'), { ...show, priorRuns: [{ openingDate: '2026-08-01', closingDate: '2026-08-30' }] }), false);
});

test('isPreRunFile: no previewsStartDate -> never hides a file (openingDate fallback removed)', () => {
  assert.equal(isPreRunFile({ data: { publishDate: '2026-09-09' } }, { openingDate: '2026-09-10' }), false);
});

// BRO-3359: 'The QR' (display) vs 'theqr' (provisional outletId, no hyphen)
// made every lookup miss and report a live review as true-missed-discovery.
const { outletIdCandidates } = require('./lib/review-gap-triage.js');

test('outletIdCandidates covers the hyphenated, compact and canonical slugs', () => {
  const ids = outletIdCandidates('The QR', 'the-qr');
  assert.deepEqual(ids.sort(), ['the-qr', 'theqr']);
  assert.deepEqual(outletIdCandidates('Variety', 'variety'), ['variety']);
});

function runWithReviewsJson(reviews, outlet) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-gap-rj-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'shows.json'), JSON.stringify({ shows: [show] }));
  fs.writeFileSync(path.join(root, 'data', 'reviews.json'), JSON.stringify({ reviews }));
  const rt = path.join(root, 'review-texts');
  fs.mkdirSync(rt, { recursive: true });
  const out = execFileSync('node', [CLI, `--show=${SHOW}`, `--outlet=${outlet}`, '--json'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, REVIEW_TEXTS_DIR: rt, BSC_DATA_REPO: path.join(root, 'no-data-repo') },
  });
  fs.rmSync(root, { recursive: true, force: true });
  return JSON.parse(out);
}

test('display name "The QR" finds a review ingested as outletId "theqr" in reviews.json', () => {
  const r = runWithReviewsJson([{ showId: SHOW, outletId: 'theqr', outlet: 'Theqr', assignedScore: 63 }], 'The QR');
  assert.notEqual(r.state, 'true-missed-discovery');
  assert.equal(r.signals.reviewsJson.inLocal, true);
});

test('an unrelated outletId still reports true-missed-discovery', () => {
  const r = runWithReviewsJson([{ showId: SHOW, outletId: 'variety', outlet: 'Variety', assignedScore: 80 }], 'The QR');
  assert.equal(r.state, 'true-missed-discovery');
});

test('display name "The QR" finds a review-texts file named theqr--<critic>.json', () => {
  const r = run({ [`${SHOW}/theqr--a-critic.json`]: { ...base, outletId: 'theqr', publishDate: '2026-09-12' } }, 'The QR');
  assert.notEqual(r.state, 'true-missed-discovery');
});
