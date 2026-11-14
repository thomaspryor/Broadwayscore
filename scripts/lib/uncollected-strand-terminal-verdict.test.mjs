// BRO-3719: duplicate-pointer tombstones and judged files are not "uncollected strands".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { assessShow, hasTerminalVerdict } = createRequire(import.meta.url)('./uncollected-strand.js');

const nowMs = Date.parse('2026-10-15T18:00:00Z');
const show = { id: 's', status: 'open', openingDate: '2026-09-01' };
const URL = 'https://www.thestage.co.uk/reviews/x-review';
const stub = (extra = {}) => ({
  url: URL, fullText: '', incompleteReason: 'not_attempted', firstSeenAt: '2026-10-01T00:00:00Z', ...extra,
});
const canonical = { url: URL, fullText: 'x'.repeat(3000) };

test('a duplicate whose canonical sibling exists is not stranded (little-shop thestage--unknown shape)', () => {
  const r = assessShow(show, [
    { file: 'thestage--matt-barton.json', review: canonical },
    { file: 'thestage--unknown.json', review: stub({ duplicateOf: 'thestage--matt-barton.json', duplicateReason: 'url-collision-detected-at-write' }) },
  ], { nowMs });
  assert.equal(r.stranded.length, 0);
});

test('a dangling duplicate pointer (canonical missing) is still a strand', () => {
  const r = assessShow(show, [
    { file: 'thestage--unknown.json', review: stub({ duplicateOf: 'thestage--gone.json' }) },
  ], { nowMs });
  assert.equal(r.stranded.length, 1);
});

test('when the canonical was never fetched either, the URL is reported exactly once (via the canonical)', () => {
  const r = assessShow(show, [
    { file: 'thestage--matt-barton.json', review: stub() },
    { file: 'thestage--unknown.json', review: stub({ duplicateOf: 'thestage--matt-barton.json' }) },
  ], { nowMs });
  assert.deepEqual(r.stranded.map(s => s.file), ['thestage--matt-barton.json']);
});

test('a plain never-attempted file with no verdict is still a strand', () => {
  const r = assessShow(show, [{ file: 'nyt--a.json', review: stub() }], { nowMs });
  assert.equal(r.stranded.length, 1);
});

test('non-review verdicts resolve a never-attempted file; fallible production guesses and empty pointers do not', () => {
  const sib = new Map([['a.json', canonical]]);
  assert.equal(hasTerminalVerdict(stub({ rejectionReason: 'not_a_review' }), sib), true);
  assert.equal(hasTerminalVerdict(stub({ isNonReview: true }), sib), true);
  assert.equal(hasTerminalVerdict(stub({ duplicateOf: 'a.json' }), sib), true);
  assert.equal(hasTerminalVerdict(stub({ wrongShow: true }), sib), false);
  assert.equal(hasTerminalVerdict(stub({ rejectionReason: 'wrong_production' }), sib), false);
  assert.equal(hasTerminalVerdict(stub({ rejectionReason: 'wrong_show' }), sib), false);
  assert.equal(hasTerminalVerdict(stub({ wrongProduction: true }), sib), false);
  assert.equal(hasTerminalVerdict(stub({ duplicateOf: null }), sib), false);
  assert.equal(hasTerminalVerdict(stub({ duplicateOf: '' }), sib), false);
});

test('a duplicate pointer cycle is not an exemption: the URL stays a strand', () => {
  const r = assessShow(show, [
    { file: 'a.json', review: stub({ duplicateOf: 'b.json' }) },
    { file: 'b.json', review: stub({ duplicateOf: 'a.json' }) },
  ], { nowMs });
  assert.equal(r.stranded.length, 2);
});

test('a verdict-resolved file still counts toward discovered, so the blackout alarm is unchanged', () => {
  const r = assessShow(show, [
    { file: 'a.json', review: stub({ rejectionReason: 'not_a_review' }) },
    { file: 'b.json', review: stub({ url: 'https://b.test/r', duplicateOf: 'a.json' }) },
  ], { nowMs });
  assert.equal(r.stranded.length, 0);
  assert.equal(r.discovered, 2);
  assert.equal(r.totalBlackout, true);
});

test('the St. Ann\'s Warehouse venue show page is a non-review on both the write and discovery paths', () => {
  const req = createRequire(import.meta.url);
  const { isBlockedReviewUrl } = req('./domain-filters.js');
  const { classifyReviewUrl } = req('./non-review-url-patterns.js');
  assert.equal(isBlockedReviewUrl('https://stannswarehouse.org/show/kramer-fauci/'), true);
  assert.equal(classifyReviewUrl('https://stannswarehouse.org/show/kramer-fauci/').ok, false);
});
