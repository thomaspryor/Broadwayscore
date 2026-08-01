import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldMarkUrlCollisionDuplicate, shouldMarkPostCorrectionDuplicate } = require('../../scripts/lib/review-write-guard.js');

const body = (n) => 'x'.repeat(n);

test('a substantive review is NOT buried under an empty same-URL stub', () => {
  // much-ado Sarah Crompton (real body) being re-written while alun-hood (empty)
  // shares the URL — must stay primary, not re-dup to the stub.
  assert.equal(shouldMarkUrlCollisionDuplicate({ fullText: body(3498) }, { fullText: '' }), false);
});

test('an empty stub IS marked duplicate of a real same-URL review', () => {
  assert.equal(shouldMarkUrlCollisionDuplicate({ fullText: '' }, { fullText: body(3498) }), true);
});

test('two empty byline-explosion stubs still collapse (one stays primary)', () => {
  assert.equal(shouldMarkUrlCollisionDuplicate({ fullText: '' }, { fullText: '' }), true);
});

test('two substantive same-URL files defer to collider (historical behavior)', () => {
  // Same review re-scraped; keep the existing dedup behavior (mark new as dup).
  assert.equal(shouldMarkUrlCollisionDuplicate({ fullText: body(3000) }, { fullText: body(2900) }), true);
});

test('a short (<500) new body defers to collider even if collider is empty', () => {
  // Below the substance floor we do not claim canonical status — conservative.
  assert.equal(shouldMarkUrlCollisionDuplicate({ fullText: body(300) }, { fullText: '' }), true);
});

test('unreadable collider (null) falls back to marking duplicate', () => {
  assert.equal(shouldMarkUrlCollisionDuplicate({ fullText: body(3000) }, null), true);
});

test('a _duplicateOfCleared breadcrumb blocks re-marking, even for a thin file', () => {
  // betrayal-2013 guardian--david-cote: a prior pass cleared the collision as
  // different-critics-same-URL; a later unrelated write (publishDate backfill)
  // must NOT re-flag duplicateOf (163 corpus-wide re-flags, 2026-07-15).
  assert.equal(shouldMarkUrlCollisionDuplicate(
    { fullText: body(300), _duplicateOfCleared: 'auto:2026-04-12 different critics' },
    { fullText: body(3000) }
  ), false);
});

test('a _duplicateOfCleared breadcrumb also blocks the unreadable-collider fallback', () => {
  assert.equal(shouldMarkUrlCollisionDuplicate(
    { fullText: '', _duplicateOfCleared: 'auto:2026-04-12 different critics' },
    null
  ), false);
});

test('without the breadcrumb, genuine duplicates still flag (no regression)', () => {
  assert.equal(shouldMarkUrlCollisionDuplicate({ fullText: body(3000), _duplicateOfCleared: null }, { fullText: body(2900) }), true);
});

// --- shouldMarkPostCorrectionDuplicate: the urlCorrectedFrom branch that used
// to be a blanket skip (the-enormous-crocodile london-theatre--unknown weekly
// oscillation, 2026-08-01) ---

test('post-correction: a bodyless corrected file adopting a sibling-owned URL IS tombstoned', () => {
  // maybeUpgradeUrl nulls fullText, so the crocodile --unknown slot always
  // arrives here bodyless — it holds nothing unique, defer to the sibling.
  assert.equal(shouldMarkPostCorrectionDuplicate(
    { fullText: null, urlCorrectedFrom: 'https://old.example/show-page' },
    { fullText: body(3000) }
  ), true);
});

test('post-correction: a substantive body is NEVER tombstoned (multi-critic same-URL protection)', () => {
  // 88 corpus files with urlCorrectedFrom + a same-URL sibling carry real
  // bodies (review probe 2026-08-01) — possibly legitimate multi-critic
  // reviews; the dedicated dedup passes own that call, not this branch.
  assert.equal(shouldMarkPostCorrectionDuplicate(
    { fullText: body(3000), urlCorrectedFrom: 'https://old.example/x' },
    { fullText: body(2900) }
  ), false);
});

test('post-correction: _duplicateOfCleared breadcrumb still wins, even bodyless', () => {
  assert.equal(shouldMarkPostCorrectionDuplicate(
    { fullText: '', _duplicateOfCleared: 'auto:2026-04-12 different critics' },
    { fullText: body(3000) }
  ), false);
});

test('post-correction: unreadable collider declines to mark (conservative, unlike the normal branch)', () => {
  assert.equal(shouldMarkPostCorrectionDuplicate({ fullText: '' }, null), false);
});

test('post-correction: body at the 200-char floor stays primary; just under it defers', () => {
  assert.equal(shouldMarkPostCorrectionDuplicate({ fullText: body(200) }, { fullText: body(3000) }), false);
  assert.equal(shouldMarkPostCorrectionDuplicate({ fullText: body(199) }, { fullText: body(3000) }), true);
});

test('post-correction: sole-score guard — bodyless file with the only score stays primary', () => {
  // ap--mark-kennedy (score 65, stars-fallback pattern) vs a scoreless bodyless
  // sibling: burying the only score-bearing copy would lose the review.
  assert.equal(shouldMarkPostCorrectionDuplicate(
    { fullText: '', assignedScore: 65 },
    { fullText: '' }
  ), false);
  assert.equal(shouldMarkPostCorrectionDuplicate(
    { fullText: '', aggregatorStars: '4/5' },
    { fullText: '' }
  ), false);
});

test('post-correction: a scored bodyless file still defers when the sibling can also score', () => {
  assert.equal(shouldMarkPostCorrectionDuplicate(
    { fullText: '', assignedScore: 91 },
    { fullText: '', aggregatorStars: '5/5' }
  ), true);
  assert.equal(shouldMarkPostCorrectionDuplicate(
    { fullText: '', assignedScore: 91 },
    { fullText: body(3000) }
  ), true);
});
