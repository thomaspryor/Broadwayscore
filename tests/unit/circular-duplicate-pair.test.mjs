/**
 * Regression tests for the circular-duplicateOf class (Notion 2026-07-11):
 * fileA.duplicateOf=fileB AND fileB.duplicateOf=fileA excludes BOTH from the
 * rebuild, silently dropping the review (242 corpus-wide).
 *
 * Covers:
 *   1. review-write-guard.wouldFormDuplicateCycle (pure) — the write-time guard.
 *   2. safeWriteReview integration — a collision write must NOT form a 2-cycle
 *      when the collider already points back at the file being written.
 *   3. fix-circular-duplicate-pairs.chooseCanonical — the repair heuristic:
 *      recovery-guard > byline > misspelling > score-richness > age > filename.
 *
 * Run: node --test tests/unit/circular-duplicate-pair.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { safeWriteReview, wouldFormDuplicateCycle } = require('../../scripts/lib/review-write-guard.js');
const {
  chooseCanonical, isUnknownByline, levenshtein, isScoreable,
} = require('../../scripts/fix-circular-duplicate-pairs.js');

const body = (n) => 'x'.repeat(n);

// ---------------------------------------------------------------------------
// 1. wouldFormDuplicateCycle (pure)
// ---------------------------------------------------------------------------
test('wouldFormDuplicateCycle: true when collider points back at this file', () => {
  assert.equal(wouldFormDuplicateCycle('nyt--brantley.json', { duplicateOf: 'nyt--brantley.json' }), true);
});
test('wouldFormDuplicateCycle: false when collider points elsewhere / nowhere', () => {
  assert.equal(wouldFormDuplicateCycle('nyt--brantley.json', { duplicateOf: 'nyt--other.json' }), false);
  assert.equal(wouldFormDuplicateCycle('nyt--brantley.json', { duplicateOf: null }), false);
  assert.equal(wouldFormDuplicateCycle('nyt--brantley.json', {}), false);
  assert.equal(wouldFormDuplicateCycle('nyt--brantley.json', null), false);
});

// ---------------------------------------------------------------------------
// 2. safeWriteReview integration — never form a 2-cycle at write time
// ---------------------------------------------------------------------------
test('safeWriteReview does NOT mark a file dup when the same-URL collider points back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyc-'));
  const url = 'https://www.nytimes.com/2026/01/01/theater/proof-review.html';
  // Sibling B already declares A canonical (B.duplicateOf = A).
  fs.writeFileSync(path.join(dir, 'nyt--unknown.json'),
    JSON.stringify({ url, fullText: body(2000), duplicateOf: 'nyt--brantley.json', duplicateReason: 'url-collision-detected-at-write' }));
  // Writing A with the same URL must NOT set A.duplicateOf = B.
  const aPath = path.join(dir, 'nyt--brantley.json');
  safeWriteReview(aPath, { url, fullText: body(3000), criticName: 'Ben Brantley' });
  const a = JSON.parse(fs.readFileSync(aPath, 'utf-8'));
  assert.equal(a.duplicateOf ?? null, null, 'A must stay primary — no cycle');
});

test('safeWriteReview clears a pre-marked duplicateOf that would form a cycle, with breadcrumb', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyc-'));
  const url = 'https://www.nytimes.com/2026/01/01/theater/proof-review.html';
  fs.writeFileSync(path.join(dir, 'nyt--unknown.json'),
    JSON.stringify({ url, fullText: body(2000), duplicateOf: 'nyt--brantley.json' }));
  const aPath = path.join(dir, 'nyt--brantley.json');
  // A arrives already (wrongly) marked dup of B — the cycle state.
  safeWriteReview(aPath, { url, fullText: body(3000), duplicateOf: 'nyt--unknown.json', duplicateReason: 'url-collision-detected-at-write' });
  const a = JSON.parse(fs.readFileSync(aPath, 'utf-8'));
  assert.equal(a.duplicateOf ?? null, null, 'cycle-forming duplicateOf cleared');
  assert.ok(a.duplicateClearReason, 'clear breadcrumb recorded so push-restore keeps the clear');
});

// ---------------------------------------------------------------------------
// 3. chooseCanonical — the repair heuristic
// ---------------------------------------------------------------------------
test('isUnknownByline: placeholders / outlet-name / numeric are unknown; real names are not', () => {
  assert.equal(isUnknownByline('unknown', 'nytimes'), true);
  assert.equal(isUnknownByline('bww-news-desk', 'broadwayworld'), true);
  assert.equal(isUnknownByline('broadwayworld', 'broadwayworld'), true);
  assert.equal(isUnknownByline('12345', 'ap'), true);
  assert.equal(isUnknownByline('', 'ap'), true);
  assert.equal(isUnknownByline('ben-brantley', 'nytimes'), false);
});

test('recovery guard: the only scoreable member is canonical even if it is "unknown"', () => {
  // The 3 real conflict cases (end-of-the-rainbow/masquerade/spamalot): bylined
  // file has NO score, unknown sibling carries the llm/assigned score.
  const c = chooseCanonical(
    'deadline--greg-evans.json', { url: 'u' },                         // no score
    'deadline--unknown.json', { url: 'u', assignedScore: 80, llmScore: { band: 'x' } },
  );
  assert.equal(c.canonical, 'deadline--unknown.json');
  assert.match(c.reason, /recovery/);
});

test('byline: named human beats unknown when both are scoreable', () => {
  const c = chooseCanonical(
    'thestage--tom-wicker.json', { url: 'u', aggregatorStars: 4 },
    'thestage--unknown.json', { url: 'u', assignedScore: 91, llmScore: { band: 'x' } },
  );
  assert.equal(c.canonical, 'thestage--tom-wicker.json');
  assert.match(c.reason, /byline/);
});

test('near-misspelling: richer-scored correct spelling wins', () => {
  assert.ok(levenshtein('greg-evans', 'greg-evens') <= 2);
  const c = chooseCanonical(
    'deadline--greg-evans.json', { url: 'u', assignedScore: 80, llmScore: { band: 'x' } },
    'deadline--greg-evens.json', { url: 'u', assignedScore: 80 },
  );
  assert.equal(c.canonical, 'deadline--greg-evans.json');
  assert.match(c.reason, /misspelling/);
});

test('score richness breaks a two-distinct-critics tie', () => {
  const c = chooseCanonical(
    'nytimes--ben-brantley.json', { url: 'u', assignedScore: 75, llmScore: { band: 'x' } },
    'nytimes--charles-isherwood.json', { url: 'u', assignedScore: 81 },
  );
  assert.equal(c.canonical, 'nytimes--ben-brantley.json');
  assert.match(c.reason, /score/);
});

test('age breaks the tie when byline + richness are equal', () => {
  const c = chooseCanonical(
    'nytimes--a-critic.json', { url: 'u', assignedScore: 75, publishDate: '2012-11-19' },
    'nytimes--b-critic.json', { url: 'u', assignedScore: 75, publishDate: '2012-11-20' },
  );
  assert.equal(c.canonical, 'nytimes--a-critic.json');
  assert.match(c.reason, /age/);
});

test('filename order is the deterministic final tiebreak', () => {
  const c = chooseCanonical(
    'nytimes--a-critic.json', { url: 'u', assignedScore: 75 },
    'nytimes--b-critic.json', { url: 'u', assignedScore: 75 },
  );
  assert.equal(c.canonical, 'nytimes--a-critic.json');
  assert.match(c.reason, /tiebreak/);
});

test('isScoreable reflects any score signal', () => {
  assert.equal(isScoreable({ assignedScore: 0 }), true);
  assert.equal(isScoreable({ aggregatorStars: 3 }), true);
  assert.equal(isScoreable({ url: 'u' }), false);
});

// ---------------------------------------------------------------------------
// 4. CI gate (--gate floor) — end-to-end via the real CLI on a fixture corpus
// ---------------------------------------------------------------------------
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/fix-circular-duplicate-pairs.js', import.meta.url));

function writeMutualPairs(root, n) {
  for (let i = 0; i < n; i++) {
    const dir = path.join(root, `show-${i}-2026`);
    fs.mkdirSync(dir, { recursive: true });
    const url = `https://example.com/review-${i}`;
    fs.writeFileSync(path.join(dir, 'outlet--a.json'),
      JSON.stringify({ url, assignedScore: 80, duplicateOf: 'outlet--b.json', duplicateReason: 'url-collision-detected-at-write' }));
    fs.writeFileSync(path.join(dir, 'outlet--b.json'),
      JSON.stringify({ url, assignedScore: 80, duplicateOf: 'outlet--a.json', duplicateReason: 'url-collision-detected-at-write' }));
  }
}

function runGate(root) {
  try {
    execFileSync('node', [SCRIPT, '--gate'], { env: { ...process.env, REVIEW_TEXTS_DIR: root }, stdio: 'pipe' });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

test('CI gate: exits non-zero on a mutual-pair SPIKE (> floor)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-spike-'));
  writeMutualPairs(root, 11); // floor is 10
  assert.equal(runGate(root), 1, 'gate must red the trunk on a producer-regression spike');
});

test('CI gate: exits zero on auto-healable drift (<= floor)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-drift-'));
  writeMutualPairs(root, 3);
  assert.equal(runGate(root), 0, 'single-pair private-repo drift must not block unrelated pushes');
});

test('CI gate: exits zero on a clean corpus', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-clean-'));
  fs.mkdirSync(path.join(root, 'clean-2026'), { recursive: true });
  fs.writeFileSync(path.join(root, 'clean-2026', 'outlet--a.json'), JSON.stringify({ url: 'u', assignedScore: 80 }));
  assert.equal(runGate(root), 0);
});
