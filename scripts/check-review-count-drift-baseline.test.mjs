// BRO-4759 / BRO-4767: check-review-count-drift.js scans EVERY show for scored review files that
// never reached reviews.json. Shows outside the opening window alert only on a NEW suppression
// (dark, or more than the threshold hidden, above data/audit/review-suppression-baseline.json).
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

function fixture({ shows = [OLD_SHOW], files = { 'old-show-2020': [['nytimes--ben-brantley.json', REVIEW]] }, baseline } = {}) {
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
    // The workflow's commit message and step summary read showsOverThreshold, so it must be there too.
    assert.deepEqual(a.showsOverThreshold.map((s) => s.showDir), ['old-show-2020']);
    assert.equal(a.summary.allShowsScanned, 1);
    assert.equal(a.summary.showsScanned, 0, 'showsScanned keeps meaning opening-window shows');
  } finally { f.cleanup(); }
});

test('a baselined suppression does not alert, but growth beyond the baseline does', () => {
  const f = fixture({ baseline: { 'old-show-2020': 1 } });
  try {
    assert.equal(f.run('--strict').status, 0);
  } finally { f.cleanup(); }
  const grown = fixture({
    baseline: { 'old-show-2020': 0 },
  });
  try {
    assert.equal(grown.run('--strict').status, 2);
  } finally { grown.cleanup(); }
});

test('--update-baseline accepts the current suppressions and the same run does not fail', () => {
  const f = fixture();
  try {
    const r = f.run('--strict', '--update-baseline');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.baselinePath, 'utf8')).shows, { 'old-show-2020': 1 });
    assert.equal(f.run('--strict').status, 0, 'the next strict run is clean');
  } finally { f.cleanup(); }
});

test('--update-baseline refuses a narrowed scan instead of erasing accepted entries', () => {
  for (const narrowing of ['--show=old-show-2020', '--window-only', '--single-show-delta=0']) {
    const f = fixture({ baseline: { 'old-show-2020': 1 } });
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
    files: { 'fresh-show-2026': [['nytimes--ben-brantley.json', { ...REVIEW, publishDate: `${today}T12:00:00-04:00`, url: 'https://nytimes.com/fresh' }]] },
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
