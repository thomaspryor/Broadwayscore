// timebomb-audit-exempt: the opening-window test stamps fixtures with new Date() (shifted by the audit preload) but the script under test runs as a real child process with an unshifted clock, so the fixture reads as future-dated; same child-process class as validate-added-review-ownership.test.mjs
// BRO-4759 / BRO-4767: check-review-count-drift.js scans EVERY show for scored review files that
// never reached reviews.json. Shows outside the opening window alert only on a NEW suppression
// (dark, or more than the threshold hidden, with a hidden file not listed in
// data/audit/review-suppression-baseline.json).
// These tests run the real script end to end against fixture files (REVIEW_TEXTS_DIR / REVIEWS_JSON /
// SHOWS_JSON / REVIEW_SUPPRESSION_BASELINE overrides), the case Kramer/Fauci's Skirball entry hit:
// an old show holding scored reviews and publishing none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-review-count-drift.js');

const OLD_SHOW = { id: 'old-show-2020', previewsStartDate: '2020-02-01', openingDate: '2020-02-11', closingDate: '2020-02-21' };
const REVIEW = {
  outletId: 'nytimes', criticName: 'Ben Brantley', humanReviewScore: 80,
  fullText: 'A glowing review of the production.', publishDate: '2020-02-12T12:00:00-04:00', url: 'https://nytimes.com/old-review',
};
const HIDDEN_FILE = 'nytimes--ben-brantley.json';

function fixture({ shows = [OLD_SHOW], files = { 'old-show-2020': [[HIDDEN_FILE, REVIEW]] }, baseline } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-baseline-'));
  const texts = path.join(root, 'review-texts');
  for (const [dir, list] of Object.entries(files)) {
    fs.mkdirSync(path.join(texts, dir), { recursive: true });
    for (const [name, data] of list) fs.writeFileSync(path.join(texts, dir, name), JSON.stringify(data));
  }
  fs.writeFileSync(path.join(root, 'shows.json'), JSON.stringify({ shows }));
  fs.writeFileSync(path.join(root, 'reviews.json'), JSON.stringify({ _meta: { lastUpdated: new Date().toISOString() }, reviews: [] }));
  const baselinePath = path.join(root, 'baseline.json');
  if (baseline) fs.writeFileSync(baselinePath, JSON.stringify({ shows: baseline }));
  const auditPath = path.join(root, 'audit.json');
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, `--audit-out=${auditPath}`, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      REVIEW_TEXTS_DIR: texts,
      REVIEWS_JSON: path.join(root, 'reviews.json'),
      SHOWS_JSON: path.join(root, 'shows.json'),
      REVIEW_SUPPRESSION_BASELINE: baselinePath,
    },
  });
  const audit = () => JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  return { root, baselinePath, run, audit, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a dark old show (scored reviews on disk, none published) fails the strict run and is named', () => {
  const f = fixture();
  try {
    const r = f.run('--strict');
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /old-show-2020/);
    const a = f.audit();
    assert.equal(a.summary.newOffenders, 1);
    assert.deepEqual(a.newOffenders[0].newFiles, [HIDDEN_FILE]);
    // Offenders stay separate from the opening-window threshold list.
    assert.deepEqual(a.showsOverThreshold, []);
    assert.equal(a.summary.allShowsScanned, 1);
    assert.equal(a.summary.showsScanned, 0, 'showsScanned keeps meaning opening-window shows');
  } finally { f.cleanup(); }
});

test('a baselined suppression does not alert, and a different hidden file is not covered by it', () => {
  const f = fixture({ baseline: { 'old-show-2020': [HIDDEN_FILE] } });
  try {
    assert.equal(f.run('--strict').status, 0);
    assert.deepEqual(f.audit().staleBaseline, []);
  } finally { f.cleanup(); }
  // A different file is hidden than the one accepted: the old entry must not cover it.
  const swapped = fixture({ baseline: { 'old-show-2020': ['some-other-file.json'] } });
  try {
    assert.equal(swapped.run('--strict').status, 2);
    const a = swapped.audit();
    assert.deepEqual(a.newOffenders[0].newFiles, [HIDDEN_FILE]);
    assert.deepEqual(a.staleBaseline, [{ showDir: 'old-show-2020', gone: ['some-other-file.json'] }]);
  } finally { swapped.cleanup(); }
});

test('--update-baseline accepts the current suppressions and the same run does not fail', () => {
  const f = fixture();
  try {
    const r = f.run('--strict', '--update-baseline');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.baselinePath, 'utf8')).shows, { 'old-show-2020': [HIDDEN_FILE] });
    assert.equal(f.run('--strict').status, 0, 'the next strict run is clean');
  } finally { f.cleanup(); }
});

test('--update-baseline refuses a narrowed scan instead of erasing accepted entries', () => {
  for (const narrowing of ['--show=old-show-2020', '--window-only', '--single-show-delta=0']) {
    const f = fixture({ baseline: { 'old-show-2020': [HIDDEN_FILE] } });
    try {
      const before = fs.readFileSync(f.baselinePath, 'utf8');
      assert.equal(f.run('--update-baseline', narrowing).status, 1, narrowing);
      assert.equal(fs.readFileSync(f.baselinePath, 'utf8'), before, `${narrowing} must leave the baseline untouched`);
    } finally { f.cleanup(); }
  }
});

test('a show inside the opening window keeps the old tolerance (a few files in flight are not an alert)', () => {
  const today = new Date().toISOString().slice(0, 10);
  const fresh = { id: 'fresh-show-2026', previewsStartDate: today, openingDate: today };
  const f = fixture({
    shows: [fresh],
    files: { 'fresh-show-2026': [[HIDDEN_FILE, { ...REVIEW, publishDate: `${today}T12:00:00-04:00`, url: 'https://nytimes.com/fresh' }]] },
  });
  try {
    const r = f.run('--strict');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.audit().summary.newOffenders, 0);
  } finally { f.cleanup(); }
});

test('--window-only restores the old scope: an old dark show is not scanned', () => {
  const f = fixture();
  try {
    assert.equal(f.run('--strict', '--window-only').status, 0);
  } finally { f.cleanup(); }
});

test('a corrupt baseline fails the run instead of reading as "nothing accepted"', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.baselinePath, '<<<<<<< HEAD\n{');
    const r = f.run('--strict');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not valid JSON/);
  } finally { f.cleanup(); }
});

test('the per-show gate (--show) ignores the baseline, so a broken baseline cannot disable it', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.baselinePath, '<<<<<<< HEAD\n{');
    const r = f.run('--show=old-show-2020', '--single-show-delta=0', '--strict');
    assert.equal(r.status, 2, r.stderr); // reaches the threshold breach (2), not the exit-1 "cannot run"
  } finally { f.cleanup(); }
});

test('summary.blindShows counts dirs the scan cannot judge (no shows.json entry or no dates)', () => {
  const f = fixture({
    shows: [OLD_SHOW, { id: 'undated-show' }],
    files: { 'old-show-2020': [[HIDDEN_FILE, REVIEW]], 'undated-show': [[HIDDEN_FILE, REVIEW]], 'no-entry-show': [[HIDDEN_FILE, REVIEW]] },
    baseline: { 'old-show-2020': [HIDDEN_FILE] },
  });
  try {
    assert.equal(f.run('--strict').status, 0);
    assert.equal(f.audit().summary.blindShows, 2);
  } finally { f.cleanup(); }
});

test('an empty shows.json fails the run instead of passing blind', () => {
  const f = fixture({ shows: [] });
  try {
    assert.equal(f.run('--strict').status, 1);
  } finally { f.cleanup(); }
});

test('--render-offenders-summary prints the table from the last audit without scanning', () => {
  const f = fixture();
  try {
    f.run('--strict');
    const r = f.run('--render-offenders-summary');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Older shows hiding scored reviews/);
    assert.match(r.stdout, /old-show-2020/);
  } finally { f.cleanup(); }
});

test('the committed baseline maps every show to a list of review file names', () => {
  const file = path.join(path.dirname(SCRIPT), '..', 'data', 'audit', 'review-suppression-baseline.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(doc.shows && typeof doc.shows === 'object');
  for (const [showDir, files] of Object.entries(doc.shows)) {
    assert.ok(Array.isArray(files) && files.every((f) => typeof f === 'string' && f.endsWith('.json')), `${showDir} must list file names`);
  }
});
