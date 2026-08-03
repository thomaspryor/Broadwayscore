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
  chooseCanonical, chooseCanonicalForRebuild, isUnknownByline, levenshtein, isScoreable,
} = require('../../scripts/fix-circular-duplicate-pairs.js');

const body = (n) => 'x'.repeat(n);

// ---------------------------------------------------------------------------
// 1. wouldFormDuplicateCycle (pure, load injected — no I/O)
// ---------------------------------------------------------------------------
test('wouldFormDuplicateCycle: true when collider points back at this file (2-node)', () => {
  const load = (name) => (name === 'nyt--other.json' ? { duplicateOf: 'nyt--brantley.json' } : null);
  assert.equal(wouldFormDuplicateCycle('nyt--brantley.json', 'nyt--other.json', load), true);
});
test('wouldFormDuplicateCycle: false when collider points elsewhere / nowhere', () => {
  const pointsElsewhere = (name) => (name === 'nyt--other.json' ? { duplicateOf: 'nyt--someone-else.json' } : null);
  assert.equal(wouldFormDuplicateCycle('nyt--brantley.json', 'nyt--other.json', pointsElsewhere), false);
  const pointsNowhere = () => ({ duplicateOf: null });
  assert.equal(wouldFormDuplicateCycle('nyt--brantley.json', 'nyt--other.json', pointsNowhere), false);
  const empty = () => ({});
  assert.equal(wouldFormDuplicateCycle('nyt--brantley.json', 'nyt--other.json', empty), false);
  const missing = () => null;
  assert.equal(wouldFormDuplicateCycle('nyt--brantley.json', 'nyt--other.json', missing), false);
  assert.equal(wouldFormDuplicateCycle('nyt--brantley.json', null, missing), false);
});
test('wouldFormDuplicateCycle: true for a 3-node cycle (A already dup of B, B already dup of C, write sets C.duplicateOf=A)', () => {
  // A.duplicateOf=B, B.duplicateOf=C already exist on disk. Writing C with
  // duplicateOf=A would close A->B->C->A — the Notion #941 washpost class,
  // now caught at write time instead of only by the post-hoc audit.
  const records = {
    'outlet--a.json': { duplicateOf: 'outlet--b.json' },
    'outlet--b.json': { duplicateOf: 'outlet--c.json' },
  };
  const load = (name) => records[name] || null;
  assert.equal(wouldFormDuplicateCycle('outlet--c.json', 'outlet--a.json', load), true);
});
test('wouldFormDuplicateCycle: false when the chain terminates without looping back', () => {
  // A.duplicateOf=B, B.duplicateOf=C, C has no duplicateOf — writing a NEW
  // file D with duplicateOf=A is not a cycle (D isn't anywhere in A's chain).
  const records = {
    'outlet--a.json': { duplicateOf: 'outlet--b.json' },
    'outlet--b.json': { duplicateOf: 'outlet--c.json' },
    'outlet--c.json': {},
  };
  const load = (name) => records[name] || null;
  assert.equal(wouldFormDuplicateCycle('outlet--d.json', 'outlet--a.json', load), false);
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

test('safeWriteReview does NOT mark a file dup when the collider chain loops back through TWO intermediate siblings (3-node cycle, Notion #941 write-time class)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyc3-'));
  const url = 'https://www.washingtonpost.com/2026/01/01/theater/proof-review/';
  // On-disk chain: charles -> other -> brantley (the file about to be written).
  // Writing brantley with the same URL as charles must NOT set
  // brantley.duplicateOf = charles, since that would close the loop.
  fs.writeFileSync(path.join(dir, 'wapo--charles.json'),
    JSON.stringify({ url, fullText: body(2000), duplicateOf: 'wapo--other.json', duplicateReason: 'url-collision-detected-at-write' }));
  fs.writeFileSync(path.join(dir, 'wapo--other.json'),
    JSON.stringify({ duplicateOf: 'wapo--brantley.json', duplicateReason: 'url-collision-detected-at-write' }));
  const aPath = path.join(dir, 'wapo--brantley.json');
  safeWriteReview(aPath, { url, fullText: body(3000), criticName: 'Ben Brantley' });
  const a = JSON.parse(fs.readFileSync(aPath, 'utf-8'));
  assert.equal(a.duplicateOf ?? null, null, 'brantley must stay primary — no 3-node cycle');
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
// 3b. chooseCanonicalForRebuild — includability-first (I/O over a fixture dir)
// ---------------------------------------------------------------------------
const longReview = 'A substantive critic review with a clear verdict and analysis. '.repeat(40);

test('includability-first: an includable-but-UNSCORED real review beats scored-but-not-includable named junk', () => {
  // The 2nd-reviewer P1: a fresh (unscored) opening-night review must NOT be
  // demoted under a wrongProduction sibling that happens to carry a named byline
  // + a score. wouldBeIncludableIfCleared must not gate on isScoreable.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-'));
  const real = { url: 'https://nyt.com/proof', contentTier: 'complete', isFullReview: true, fullText: longReview, duplicateOf: 'nyt--junk.json' }; // includable, unscored
  const junk = { url: 'https://nyt.com/proof', contentTier: 'complete', isFullReview: true, fullText: longReview, assignedScore: 80, llmScore: { band: 'x' }, wrongProduction: true, duplicateOf: 'nyt--real.json' }; // scored, NOT includable
  fs.writeFileSync(path.join(dir, 'nyt--real.json'), JSON.stringify(real));
  fs.writeFileSync(path.join(dir, 'nyt--junk.json'), JSON.stringify(junk));
  const c = chooseCanonicalForRebuild('nyt--real.json', real, 'nyt--junk.json', junk, dir);
  assert.equal(c.canonical, 'nyt--real.json', 'the includable real review must be canonical, not the scored wrongProduction junk');
  assert.match(c.reason, /rebuild/);
});

test('includability-first: both includable → the scored one is kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-'));
  const a = { url: 'u', contentTier: 'complete', isFullReview: true, fullText: longReview, duplicateOf: 'o--b.json' }; // includable, unscored
  const b = { url: 'u', contentTier: 'complete', isFullReview: true, fullText: longReview, assignedScore: 88, duplicateOf: 'o--a.json' }; // includable, scored
  fs.writeFileSync(path.join(dir, 'o--a.json'), JSON.stringify(a));
  fs.writeFileSync(path.join(dir, 'o--b.json'), JSON.stringify(b));
  const c = chooseCanonicalForRebuild('o--a.json', a, 'o--b.json', b, dir);
  assert.equal(c.canonical, 'o--b.json', 'among includables, prefer the scored member');
});

// ---------------------------------------------------------------------------
// 3c. force:true canonical write must NOT re-mark the (shared-URL) canonical dup
// ---------------------------------------------------------------------------
test('safeWriteReview force:true skips the URL-collision block (canonical stays primary vs shared-URL loser)', () => {
  // The repair writes the canonical with force:true precisely because the loser
  // shares its URL; a non-forced write would re-fire the collision detector and
  // re-mark the canonical duplicate, silently no-op'ing the fix. Lock it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'force-'));
  const url = 'https://nyt.com/all-my-sons';
  fs.writeFileSync(path.join(dir, 'nyt--loser.json'), JSON.stringify({ url, fullText: body(2000), duplicateOf: 'nyt--canon.json', duplicateReason: 'url-collision-detected-at-write' }));
  const canonPath = path.join(dir, 'nyt--canon.json');
  safeWriteReview(canonPath, { url, fullText: body(3000), assignedScore: 82, duplicateOf: null, duplicateReason: null, duplicateClearReason: 'repair' }, { force: true });
  const canon = JSON.parse(fs.readFileSync(canonPath, 'utf-8'));
  assert.equal(canon.duplicateOf ?? null, null, 'force:true must not re-mark the canonical duplicate despite the shared-URL loser');
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

// ---------------------------------------------------------------------------
// 5. Cross-market exclusion (2026-07-12 class-A main red) — end-to-end via CLI.
//    A mutual pair whose members are dated on a same-title SIBLING production's
//    opening (but far from their own show's opening) must NEVER be canonicalized:
//    clearing duplicateOf un-suppressed a wrong-show review and reddened main.
//    Run through the real --fix so module-level shows.json caching is isolated
//    per process (env-driven), which a same-process import cannot exercise.
// ---------------------------------------------------------------------------
function runFix(root, showsJsonPath) {
  execFileSync('node', [SCRIPT, '--fix'], {
    env: { ...process.env, REVIEW_TEXTS_DIR: root, SHOWS_JSON: showsJsonPath },
    stdio: 'pipe',
  });
}

test('cross-market: a class-A colliding mutual pair is left suppressed (duplicateOf stays set on BOTH); a clean pair is still repaired', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xmarket-'));
  const showsJson = path.join(root, 'shows.json');
  fs.writeFileSync(showsJson, JSON.stringify([
    // Same-title siblings across markets: WE run (2024) + Broadway run (2025).
    { id: 'operation-mincemeat-west-end-2024', title: 'Operation Mincemeat', openingDate: '2024-05-01', category: 'west-end' },
    { id: 'operation-mincemeat-2025', title: 'Operation Mincemeat', openingDate: '2025-03-20', category: 'broadway' },
    // A unique-title show — its pair is a normal, non-contaminated 2-cycle.
    { id: 'some-clean-play-2026', title: 'Some Clean Play', openingDate: '2026-04-01', category: 'broadway' },
  ]));

  // Contaminated pair under the WE folder: both dated on the Broadway sibling's
  // opening (2025-03-20), ~323d from the WE opening → class-A. Both includable.
  const cDir = path.join(root, 'operation-mincemeat-west-end-2024');
  fs.mkdirSync(cDir, { recursive: true });
  const cUrl = 'https://www.westendtheatre.com/335071/news/reviews/american-psycho';
  const contam = (dup) => ({
    url: cUrl, publishDate: 'March 20, 2025', contentTier: 'complete', isFullReview: true,
    fullText: longReview, assignedScore: 80, duplicateOf: dup, duplicateReason: 'url-collision-detected-at-write',
  });
  fs.writeFileSync(path.join(cDir, 'timeout--unknown.json'), JSON.stringify(contam('timeout--paul-raven.json')));
  fs.writeFileSync(path.join(cDir, 'timeout--paul-raven.json'), JSON.stringify(contam('timeout--unknown.json')));

  // Clean pair: dated on its own show's opening → not class-A → normal repair.
  const kDir = path.join(root, 'some-clean-play-2026');
  fs.mkdirSync(kDir, { recursive: true });
  const kUrl = 'https://example.com/some-clean-play';
  const clean = (dup) => ({
    url: kUrl, publishDate: '2026-04-02', contentTier: 'complete', isFullReview: true,
    fullText: longReview, assignedScore: 80, duplicateOf: dup, duplicateReason: 'url-collision-detected-at-write',
  });
  fs.writeFileSync(path.join(kDir, 'outlet--a.json'), JSON.stringify(clean('outlet--b.json')));
  fs.writeFileSync(path.join(kDir, 'outlet--b.json'), JSON.stringify(clean('outlet--a.json')));

  runFix(root, showsJson);

  // Contaminated pair: BOTH still point at each other → the 2-cycle is intact →
  // the rebuild keeps both suppressed → the wrong-show review never surfaces.
  const cu = JSON.parse(fs.readFileSync(path.join(cDir, 'timeout--unknown.json'), 'utf-8'));
  const cp = JSON.parse(fs.readFileSync(path.join(cDir, 'timeout--paul-raven.json'), 'utf-8'));
  assert.equal(cu.duplicateOf, 'timeout--paul-raven.json', 'class-A member must NOT be canonicalized');
  assert.equal(cp.duplicateOf, 'timeout--unknown.json', 'class-A member must NOT be canonicalized');

  // Clean pair: exactly one member canonicalized (duplicateOf cleared), one still dup.
  const ka = JSON.parse(fs.readFileSync(path.join(kDir, 'outlet--a.json'), 'utf-8'));
  const kb = JSON.parse(fs.readFileSync(path.join(kDir, 'outlet--b.json'), 'utf-8'));
  const cleared = [ka, kb].filter(x => (x.duplicateOf ?? null) === null).length;
  assert.equal(cleared, 1, 'the non-contaminated pair is still collapsed to exactly one canonical');
});

test('cross-market: --fix FAILS CLOSED when shows.json is unavailable (guard inert → refuse to repair)', () => {
  // A colliding pair with NO shows.json: the guard cannot see siblings, so the
  // safe action is to refuse the repair (else it would re-canonicalize a
  // contaminated member — the exact 2026-07-12 regression). SHOWS_JSON pointed
  // at an empty-array file is authoritative (no fallback), so no shows load.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failclosed-'));
  const emptyShows = path.join(root, 'empty-shows.json');
  fs.writeFileSync(emptyShows, JSON.stringify([]));
  const dir = path.join(root, 'show-x-2026');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'outlet--a.json'),
    JSON.stringify({ url: 'u', assignedScore: 80, duplicateOf: 'outlet--b.json', duplicateReason: 'url-collision-detected-at-write' }));
  fs.writeFileSync(path.join(dir, 'outlet--b.json'),
    JSON.stringify({ url: 'u', assignedScore: 80, duplicateOf: 'outlet--a.json', duplicateReason: 'url-collision-detected-at-write' }));

  let status = 0;
  try {
    execFileSync('node', [SCRIPT, '--fix'], {
      env: { ...process.env, REVIEW_TEXTS_DIR: root, SHOWS_JSON: emptyShows }, stdio: 'pipe',
    });
  } catch (e) { status = e.status ?? 1; }
  assert.equal(status, 1, '--fix must refuse (exit 1) when shows.json is unavailable');
  // Nothing repaired — both members still point at each other.
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'outlet--a.json'), 'utf-8'));
  const b = JSON.parse(fs.readFileSync(path.join(dir, 'outlet--b.json'), 'utf-8'));
  assert.equal(a.duplicateOf, 'outlet--b.json', 'no repair happened');
  assert.equal(b.duplicateOf, 'outlet--a.json', 'no repair happened');
});

test('cross-market: _auditAllowCrossMarket carve-out — allowlisting one member canonicalizes it (parity with the audit)', () => {
  // A human allowlisted the real review as belonging here despite the date
  // coincidence. fix-circular must honor that (not skip), and make the
  // allowlisted member canonical — matching the audit's !_auditAllowCrossMarket.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'allow-'));
  const showsJson = path.join(root, 'shows.json');
  fs.writeFileSync(showsJson, JSON.stringify([
    { id: 'op-mincemeat-we-2024', title: 'Operation Mincemeat', openingDate: '2024-05-01', category: 'west-end' },
    { id: 'op-mincemeat-2025', title: 'Operation Mincemeat', openingDate: '2025-03-20', category: 'broadway' },
  ]));
  const dir = path.join(root, 'op-mincemeat-we-2024');
  fs.mkdirSync(dir, { recursive: true });
  const url = 'https://example.com/om';
  // Both dated on the sibling opening → both would be class-A; but the real one
  // is allowlisted, so only the junk sibling stays class-A → clean one wins.
  fs.writeFileSync(path.join(dir, 'timeout--real.json'), JSON.stringify({
    url, publishDate: 'March 20, 2025', contentTier: 'complete', isFullReview: true, fullText: longReview,
    assignedScore: 80, _auditAllowCrossMarket: true, duplicateOf: 'timeout--junk.json', duplicateReason: 'url-collision-detected-at-write',
  }));
  fs.writeFileSync(path.join(dir, 'timeout--junk.json'), JSON.stringify({
    url, publishDate: 'March 20, 2025', contentTier: 'complete', isFullReview: true, fullText: longReview,
    assignedScore: 80, duplicateOf: 'timeout--real.json', duplicateReason: 'url-collision-detected-at-write',
  }));
  runFix(root, showsJson);
  const real = JSON.parse(fs.readFileSync(path.join(dir, 'timeout--real.json'), 'utf-8'));
  const junk = JSON.parse(fs.readFileSync(path.join(dir, 'timeout--junk.json'), 'utf-8'));
  assert.equal(real.duplicateOf ?? null, null, 'allowlisted member is canonicalized (not suppressed)');
  assert.equal(junk.duplicateOf, 'timeout--real.json', 'junk sibling stays a duplicate of the canonical');
});
