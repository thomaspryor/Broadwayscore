import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldMarkUrlCollisionDuplicate } = require('../../scripts/lib/review-write-guard.js');

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
