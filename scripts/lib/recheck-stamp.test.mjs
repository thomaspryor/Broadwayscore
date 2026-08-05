import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseRecheckAfter, parseRecheckAfterFromCard, hoistRecheckAfterStamp } = require('./recheck-stamp.js');

test('parseRecheckAfter reads a stamp as midnight UTC of that day', () => {
  assert.equal(parseRecheckAfter('RECHECK-AFTER: 2026-08-08'), Date.parse('2026-08-08T00:00:00Z'));
  assert.equal(parseRecheckAfter('recheck-after: 2026-08-08 (case-insensitive)'), Date.parse('2026-08-08T00:00:00Z'));
});

test('parseRecheckAfter returns null on missing or malformed stamps', () => {
  assert.equal(parseRecheckAfter('no stamp here'), null);
  assert.equal(parseRecheckAfter(''), null);
  assert.equal(parseRecheckAfter(null), null);
  assert.equal(parseRecheckAfter(undefined), null);
  assert.equal(parseRecheckAfter('RECHECK-AFTER: soon'), null);
});

test('parseRecheckAfterFromCard scans notes, then outcome, then name', () => {
  assert.equal(
    parseRecheckAfterFromCard({ notes: 'x', outcome: 'RECHECK-AFTER: 2026-08-03', name: 'y' }),
    Date.parse('2026-08-03T00:00:00Z'),
  );
  assert.equal(
    parseRecheckAfterFromCard({ name: 'watch until RECHECK-AFTER: 2026-08-04' }),
    Date.parse('2026-08-04T00:00:00Z'),
  );
});

test('notes stamp wins over a disagreeing outcome stamp', () => {
  assert.equal(
    parseRecheckAfterFromCard({ notes: 'RECHECK-AFTER: 2026-08-10', outcome: 'RECHECK-AFTER: 2026-08-01' }),
    Date.parse('2026-08-10T00:00:00Z'),
  );
});

test('parseRecheckAfterFromCard is null-safe', () => {
  assert.equal(parseRecheckAfterFromCard(null), null);
  assert.equal(parseRecheckAfterFromCard({}), null);
  assert.equal(parseRecheckAfterFromCard({ notes: null, outcome: undefined }), null);
});

// task #802: a stamp buried past the ~1800-char Notion property preview
// (notion-brain.js PROP_CHUNK) is invisible to stuck-work.js's classifier —
// it never sees the page-body overflow. hoistRecheckAfterStamp is called on
// the final outcome text right before that truncation so the stamp always
// survives in the preview.
test('hoistRecheckAfterStamp duplicates a buried stamp at the front', () => {
  const buried = 'x'.repeat(2000) + '\n\nRECHECK-AFTER: 2026-08-17\n\nmore text';
  const hoisted = hoistRecheckAfterStamp(buried);
  assert.ok(hoisted.startsWith('RECHECK-AFTER: 2026-08-17\n\n'));
  assert.ok(hoisted.includes(buried), 'original text preserved after the hoisted line');
  assert.equal(parseRecheckAfter(hoisted.slice(0, 1800)), Date.parse('2026-08-17T00:00:00Z'));
});

test('hoistRecheckAfterStamp is a no-op when the stamp is already at index 0', () => {
  const alreadyHead = 'RECHECK-AFTER: 2026-08-17\n\nsome outcome text';
  assert.equal(hoistRecheckAfterStamp(alreadyHead), alreadyHead);
});

test('hoistRecheckAfterStamp is a no-op with no stamp present', () => {
  assert.equal(hoistRecheckAfterStamp('no stamp here'), 'no stamp here');
  assert.equal(hoistRecheckAfterStamp(''), '');
});

// Codex ship-check catch (task #802): hoisting a stamp in front of a head
// `## Parked <date>` marker knocks it off index 0, so park-marker.js's
// head-anchored parseParkedDate() stops recognizing it — a parked card
// would silently misclassify as awaiting-recheck/critical instead of parked.
test('hoistRecheckAfterStamp never hoists past a head Parked marker', () => {
  const parked = '## Parked 2026-08-03\nOwner closed its workspace. Resume with `--id 1 --force`.\n\n---\n\nRECHECK-AFTER: 2026-08-01 (old, buried)';
  assert.equal(hoistRecheckAfterStamp(parked), parked);
});
