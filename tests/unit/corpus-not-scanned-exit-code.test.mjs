/**
 * BRO-3549: a corpus audit must exit CORPUS_NOT_SCANNED_EXIT_CODE (2, "could
 * not run") when its corpus is missing or empty, never 1 — 1 is each of these
 * scripts' drift code, and check-corpus-drift.js reads the exit code to tell a
 * crashed audit from real drift (crashCodes: [2] on every entry below).
 *
 * Runs the REAL scripts (CLAUDE.md §15) against a disposable root: a temp dir
 * whose `scripts` and `node_modules` are symlinks to this checkout's, launched
 * with --preserve-symlinks(-main) so each script's `__dirname/..` resolves to
 * the temp root and it reads (and writes) only the temp `data/`. The real data
 * directory is never touched.
 *
 * For every audit: corpus missing → 2, corpus empty → 2, a tiny healthy
 * fixture corpus → anything but 2 (it ran; 0 or 1 is the audit's own verdict).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const REPO = path.resolve(import.meta.dirname, '../..');
const { AUDITS } = require('../../scripts/check-corpus-drift.js');
const {
  CORPUS_NOT_SCANNED_EXIT_CODE,
  CorpusNotScannedError,
  exitIfCorpusNotScanned,
} = require('../../scripts/lib/corpus-scan-guard.js');

const SHOWS = {
  shows: [
    { id: 'alpha-2024', title: 'Alpha', status: 'open', openingDate: '2024-03-01', venue: 'Booth Theatre' },
    { id: 'beta-2023', title: 'Beta', status: 'open', openingDate: '2023-05-01', venue: 'Lyceum Theatre' },
  ],
};
const REVIEW = {
  showId: 'alpha-2024',
  outletId: 'nytimes',
  outlet: 'The New York Times',
  criticName: 'Jane Critic',
  url: 'https://www.nytimes.com/2024/03/01/theater/alpha-review.html',
  publishDate: '2024-03-01',
  fullText: 'A review of Alpha. '.repeat(40),
};

const REFERENCE_DATA = ['west-end-venues.json', 'off-broadway-venues.json'];

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

// corpus: 'missing' | 'empty' | 'healthy'
function makeRoot(kind, corpus) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bro-3549-${kind}-${corpus}-`));
  fs.symlinkSync(path.join(REPO, 'scripts'), path.join(root, 'scripts'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'));
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(data, 'audit'), { recursive: true });
  writeJson(path.join(data, 'shows.json'), SHOWS);
  // Public reference files some shared libs require() at load time (copied,
  // so nothing a script does can reach the real data/).
  for (const f of REFERENCE_DATA) fs.copyFileSync(path.join(REPO, 'data', f), path.join(data, f));
  writeJson(path.join(data, 'audit', 'self-contradictory-clears-baseline.json'), { count: 0, tolerance: 5 });

  if (kind === 'review-texts') {
    const dir = path.join(data, 'review-texts');
    if (corpus !== 'missing') fs.mkdirSync(dir);
    if (corpus === 'healthy') writeJson(path.join(dir, 'alpha-2024', 'nytimes--jane-critic.json'), REVIEW);
  } else if (kind === 'aggregator-archive') {
    const dir = path.join(data, 'aggregator-archive');
    if (corpus !== 'missing') fs.mkdirSync(dir);
    if (corpus === 'healthy') {
      fs.mkdirSync(path.join(dir, 'dtli'));
      fs.writeFileSync(path.join(dir, 'dtli', 'alpha-2024.html'), '<html><head><title>Alpha Reviews</title></head><body></body></html>');
    }
  } else if (kind === 'show-score-urls') {
    // This audit's "corpus" is data/show-score-urls.json.
    writeJson(path.join(data, 'show-score.json'), { shows: {} });
    fs.mkdirSync(path.join(data, 'review-texts'));
    if (corpus === 'empty') writeJson(path.join(data, 'show-score-urls.json'), { shows: {} });
    if (corpus === 'healthy') {
      writeJson(path.join(data, 'show-score-urls.json'), {
        shows: { 'alpha-2024': 'https://www.show-score.com/broadway-shows/alpha' },
      });
    }
  }
  return root;
}

// Every AUDITS entry this card moved onto the shared exit code, and which
// input counts as its corpus.
const CASES = [
  ['duplicate-shows', 'review-texts'],
  ['show-score-urls', 'show-score-urls'],
  ['self-contradictory-clears', 'review-texts'],
  ['aggregator-archive-integrity', 'aggregator-archive'],
  ['critic-outlets', 'review-texts'],
  ['autoclear-vs-ensemble', 'review-texts'],
  ['contradicted-flag-basis', 'review-texts'],
  ['duplicate-of-cleared-contradiction', 'review-texts'],
  ['url-downgrade', 'review-texts'],
];

const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function runAuditIn(root, audit) {
  return spawnSync(
    process.execPath,
    ['--preserve-symlinks', '--preserve-symlinks-main', path.join(root, 'scripts', audit.script), ...audit.args],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
  );
}

test('the shared exit code is 2 and is listed as a crash code by the reference audits', () => {
  assert.equal(CORPUS_NOT_SCANNED_EXIT_CODE, 2);
  for (const name of ['sibling-title-misroute', 'cv-flag-contradiction']) {
    assert.ok(AUDITS.find((a) => a.name === name).crashCodes.includes(2), name);
  }
});

test('exitIfCorpusNotScanned rethrows anything that is not a CorpusNotScannedError', () => {
  const boom = new TypeError('unrelated');
  assert.throws(() => exitIfCorpusNotScanned(boom), (e) => e === boom);
});

test('exitIfCorpusNotScanned exits with the shared code on CorpusNotScannedError', () => {
  const guard = path.join(REPO, 'scripts', 'lib', 'corpus-scan-guard.js');
  const r = spawnSync(process.execPath, ['-e',
    `const g = require(${JSON.stringify(guard)});` +
    'try { g.assertCorpusScanned(0, { gate: true }); } catch (e) { g.exitIfCorpusNotScanned(e); }'],
  { encoding: 'utf8' });
  assert.equal(r.status, CORPUS_NOT_SCANNED_EXIT_CODE);
  assert.match(r.stderr, /FAIL: scanned 0 review files/);
  assert.ok(CorpusNotScannedError);
});

for (const [name, kind] of CASES) {
  describe(`${name} (BRO-3549)`, () => {
    let audit;
    before(() => {
      audit = AUDITS.find((a) => a.name === name);
      assert.ok(audit, `AUDITS entry ${name} missing`);
    });

    test('AUDITS lists the shared code as a crash code, and drift (1) is not one', () => {
      assert.ok(audit.crashCodes.includes(CORPUS_NOT_SCANNED_EXIT_CODE), `${name} crashCodes`);
      assert.equal(audit.crashCodes.includes(1), false, `${name}: 1 is drift, never a crash`);
    });

    for (const corpus of ['missing', 'empty']) {
      test(`${corpus} corpus → exit ${CORPUS_NOT_SCANNED_EXIT_CODE} (could not run), not 1 (drift)`, () => {
        const root = makeRoot(kind, corpus);
        roots.push(root);
        const r = runAuditIn(root, audit);
        assert.equal(r.status, CORPUS_NOT_SCANNED_EXIT_CODE,
          `${name} with ${corpus} ${kind} exited ${r.status}\n${(r.stdout || '').slice(-800)}\n${(r.stderr || '').slice(-800)}`);
      });
    }

    test('healthy fixture corpus → the audit runs (not the crash code)', () => {
      const root = makeRoot(kind, 'healthy');
      roots.push(root);
      const r = runAuditIn(root, audit);
      assert.notEqual(r.status, null, `${name} timed out or was killed`);
      assert.notEqual(r.status, CORPUS_NOT_SCANNED_EXIT_CODE,
        `${name} with a healthy fixture exited ${r.status}\n${(r.stdout || '').slice(-800)}\n${(r.stderr || '').slice(-800)}`);
    });
  });
}
