import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { reconcileProtectedFields } = require('./restore-protected-fields.js');

// #1916: push-review-texts' action.yml tie-break resolves a JSON conflict by
// fullText length and keeps "theirs" (remote) whenever OUR_LEN <= THEIR_LEN —
// discarding our whole commit for that file. When our commit had freshly set
// a MANUAL_FIELDS value (e.g. wrongShowOverride from
// clear-stale-wrong-show-flags.js) and remote never had it, local ends up
// identical to remote post-tie-break and the field is gone with no error.
// ours (ORIG_HEAD, the pre-rebase ORIGINAL local commit) still has it — this
// must be restored from there since remote can't help.
test('restores a MANUAL_FIELDS value present only in ours (pre-tie-break) and absent from both local and remote', () => {
  const remote = {
    url: 'https://example.com/review',
    fullText: 'a'.repeat(500), // longer -> tie-break kept "theirs" (remote)
    wrongShow: true,
  };
  // post-tie-break working tree: identical to remote for this file
  const local = { ...remote };
  // pre-rebase HEAD: our commit had cleared wrongShow and stamped the
  // override breadcrumbs, but our fullText was shorter so we lost the tie
  const ours = {
    url: 'https://example.com/review',
    fullText: 'a'.repeat(10),
    wrongShow: false,
    wrongShowManualClear: true,
    wrongShowOverride: true,
    wrongShowOverrideReason: 'clear-stale-wrong-show-flags.js: predicate-only',
    wrongShowOverrideAt: '2026-08-26T00:00:00.000Z',
  };

  const { modified, notes } = reconcileProtectedFields(local, remote, ours, { staleCheckoutGuard: true });

  assert.equal(modified, true);
  // wrongShow itself is handled by the existing false/true flip special-case
  assert.equal(local.wrongShow, false);
  // the breadcrumb fields are only present in `ours` — must come from the new fallback
  assert.equal(local.wrongShowManualClear, true);
  assert.equal(local.wrongShowOverride, true);
  assert.equal(local.wrongShowOverrideReason, 'clear-stale-wrong-show-flags.js: predicate-only');
  assert.equal(local.wrongShowOverrideAt, '2026-08-26T00:00:00.000Z');
  assert.ok(notes.some((n) => n.includes('wrongShowOverride') && n.includes('pre-rebase HEAD')));
});

test('does not restore from ours when remote already provides the field', () => {
  const remote = { url: 'https://example.com/review', humanReviewScore: 88 };
  const local = { ...remote };
  const ours = { url: 'https://example.com/review', humanReviewScore: 12 };

  const { notes } = reconcileProtectedFields(local, remote, ours, { staleCheckoutGuard: true });

  // remote already had it (matches local) — no restore needed, and if one
  // fired it must not have clobbered the correct remote value with ours'.
  assert.equal(local.humanReviewScore, 88);
  assert.ok(!notes.some((n) => n.includes('humanReviewScore')));
});

test('does not resurrect a field the LOCAL record deliberately cleared, even from ours', () => {
  const remote = { url: 'https://example.com/review' };
  // local deliberately cleared duplicateOf and carries the breadcrumb
  const local = { url: 'https://example.com/review', duplicateClearReason: 'not actually a duplicate' };
  const ours = { url: 'https://example.com/review', duplicateOf: 'other-show/other-file.json' };

  const { modified } = reconcileProtectedFields(local, remote, ours, { staleCheckoutGuard: true });

  assert.equal(local.duplicateOf, undefined);
  assert.equal(modified, false);
});

test('restores from ours when ours is unavailable is a no-op (null ours)', () => {
  const remote = { url: 'https://example.com/review' };
  const local = { url: 'https://example.com/review' };

  const { modified, notes } = reconcileProtectedFields(local, remote, null, {});

  assert.equal(modified, false);
  assert.deepEqual(notes, []);
});
