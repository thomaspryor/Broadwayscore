import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findOverlappingCards, filePathsIn, titlesOverlap } = require('./dispatch-overlap-check.js');

test('findOverlappingCards flags an in_progress card sharing a scripts/ file path (#893/#902 class)', () => {
  const target = { id: '902', subject: 'Coverage Verdict S0: foundations', notes: 'Fix scripts/audit-show-review-gap.js self-clobber.' };
  const other = { id: '893', subject: 'Send-day gap-audit state is self-clobbering', notes: 'scripts/audit-show-review-gap.js overwrites its own state.' };
  const hits = findOverlappingCards(target, [other]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].card.id, '893');
  assert.equal(hits[0].reason, 'shared-file-path');
  assert.deepEqual(hits[0].sharedPaths, ['scripts/audit-show-review-gap.js']);
});

test('findOverlappingCards flags a byte-identical title as exact-title-match, not similar-title (task #1672: this is proof, not a hint)', () => {
  const target = { id: '911', subject: 'Extract pushCookieSecretWithMeta() helper so #850/#876 OTP-login outlets inherit cookie freshness fix', notes: '' };
  const other = { id: '897', subject: 'Extract pushCookieSecretWithMeta() helper so #850/#876 OTP-login outlets inherit cookie freshness fix', notes: '' };
  const hits = findOverlappingCards(target, [other]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].card.id, '897');
  assert.equal(hits[0].reason, 'exact-title-match');
});

test('findOverlappingCards flags a true prefix (non-identical) title overlap as similar-title (#897/#911-style near-miss)', () => {
  const target = { id: '911', subject: 'Extract pushCookieSecretWithMeta() helper so #850/#876 OTP-login outlets inherit cookie freshness fix', notes: '' };
  const other = { id: '897', subject: 'Extract pushCookieSecretWithMeta() helper so #850/#876 OTP-login outlets inherit cookie freshness', notes: '' };
  const hits = findOverlappingCards(target, [other]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].card.id, '897');
  assert.equal(hits[0].reason, 'similar-title');
});

test('findOverlappingCards ignores unrelated cards', () => {
  const target = { id: '1', subject: 'Fix homepage rage clicks', notes: 'scripts/audit-rage-clicks.js' };
  const other = { id: '2', subject: 'Send-day gap-audit state is self-clobbering', notes: 'scripts/audit-show-review-gap.js overwrites its own state.' };
  assert.deepEqual(findOverlappingCards(target, [other]), []);
});

test('findOverlappingCards excludes the target card itself even if it appears in the in_progress list', () => {
  const target = { id: '5', subject: 'Fix scripts/foo.js bug', notes: 'scripts/foo.js' };
  assert.deepEqual(findOverlappingCards(target, [target]), []);
});

test('findOverlappingCards returns ALL colliding cards, not just the first', () => {
  const target = { id: '1', subject: 'Fix scripts/foo.js bug', notes: 'scripts/foo.js' };
  const a = { id: '2', subject: 'Unrelated but touches scripts/foo.js too', notes: 'scripts/foo.js' };
  const b = { id: '3', subject: 'Fix scripts/foo.js bug', notes: '' }; // near-identical title
  const c = { id: '4', subject: 'Totally different long unrelated title text', notes: 'scripts/bar.js' };
  const hits = findOverlappingCards(target, [a, b, c]);
  assert.deepEqual(hits.map(h => h.card.id).sort(), ['2', '3']);
});

test('findOverlappingCards handles missing/malformed input without throwing', () => {
  assert.deepEqual(findOverlappingCards(null, [{ id: '1' }]), []);
  assert.deepEqual(findOverlappingCards({ id: '1', subject: 'x' }, null), []);
  assert.deepEqual(findOverlappingCards({ id: '1', subject: 'x' }, [null, undefined]), []);
});

test('filePathsIn extracts scripts/ paths and ignores non-scripts paths', () => {
  const text = 'Touches scripts/lib/foo.js and src/app/page.tsx and scripts/bar.sh, also scripts/baz.py (unsupported ext)';
  assert.deepEqual([...filePathsIn(text)].sort(), ['scripts/bar.sh', 'scripts/lib/foo.js']);
});

test('titlesOverlap requires both titles to clear the 20-char floor', () => {
  assert.equal(titlesOverlap('Fix: CI red', 'Fix: CI red today'), false); // too short
  assert.equal(titlesOverlap('Extract the shared helper function', 'Extract the shared helper function today'), true);
  assert.equal(titlesOverlap('Extract the shared helper function', 'Completely unrelated long title here'), false);
});
