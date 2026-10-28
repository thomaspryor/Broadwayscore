import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { buildDigest, coerceEntry, DIGEST_CHAR_CAP } = createRequire(import.meta.url)('../sync-pending-review-to-linear.js');

const mk = (n) => Array.from({ length: n }, (_, i) => ({
  slug: `show-${i}`, title: `Show ${i}`, heldSince: '2026-01-01',
  reason: 'x'.repeat(300), attemptedQueries: Array(5).fill('q'.repeat(200)),
}));

test('digest stays under Linear body limit with many entries (BRO-6209)', () => {
  const d = buildDigest(mk(180));
  assert.ok(d.length <= DIGEST_CHAR_CAP, `len ${d.length}`);
  assert.match(d, /more pending entries omitted/);
});

test('small digest is not truncated', () => {
  const d = buildDigest(mk(3));
  assert.doesNotMatch(d, /omitted/);
  assert.match(d, /show-2/);
});

// BRO-6471: with the owner email retired, this card is the only place a held row's hold reason shows.
test('a row the apply pass held shows what it needs, even with no reason or notes', () => {
  const held = coerceEntry({ slug: 'hamilton', recouped: true, autoApplyBlocked: 'recoupment claim: a person must confirm it against the cited source' }, 0, null);
  const d = buildDigest([held, coerceEntry({ slug: 'wicked', notes: 'low-confidence figure' }, 1, null)]);
  assert.match(d, /### hamilton\n[^#]*- Needs: recoupment claim: a person must confirm it/);
  assert.doesNotMatch(d.split('### wicked')[1], /- Needs:/);
});
