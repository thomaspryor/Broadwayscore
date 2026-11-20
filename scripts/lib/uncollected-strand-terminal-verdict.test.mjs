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
  // BRO-7901: a different-URL sibling, so only the verdict (not a same-URL fetch) is under test.
  const sib = new Map([['a.json', { ...canonical, url: 'https://example.com/unrelated' }]]);
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

// BRO-7901: re-seeded stub beside a same-URL file that was already fetched/judged.
test('a stub whose URL a sibling already fetched (even if judged wrong-production) is not stranded', () => {
  const judged = { url: URL, fullText: '', incompleteReason: 'wrong_content', wrongProduction: true, textFetchedAt: '2026-10-14T00:00:00Z' };
  const r = assessShow(show, [
    { file: 'chicago-reader--kelly-kleiman.json', review: judged },
    { file: 'chicago-reader--unknown.json', review: stub({ url: URL + '/' }) },
  ], { nowMs });
  assert.equal(r.stranded.length, 0);
});

test('same-URL siblings that are both never-attempted are each still stranded', () => {
  const r = assessShow(show, [
    { file: 'a.json', review: stub() },
    { file: 'b.json', review: stub() },
  ], { nowMs });
  assert.equal(r.stranded.length, 2);
});

test('a different-URL fetched sibling does not exempt a stub', () => {
  const r = assessShow(show, [
    { file: 'a.json', review: canonical },
    { file: 'b.json', review: stub({ url: 'https://example.com/other' }) },
  ], { nowMs });
  assert.equal(r.stranded.length, 1);
});

test('a sibling that never fetched anything (awaiting-text-collection / bot_blocked) does not hide the stub', () => {
  for (const reason of ['awaiting-text-collection', 'bot_blocked', undefined]) {
    const r = assessShow(show, [
      { file: 'a.json', review: { url: URL, fullText: '', incompleteReason: reason } },
      { file: 'b.json', review: stub() },
    ], { nowMs });
    assert.equal(r.stranded.length, 1, String(reason));
  }
});

test('hasTerminalVerdict itself ignores same-URL siblings (poller shares it)', () => {
  const a = { url: URL, fullText: 'x'.repeat(300), contentTier: 'excerpt' };
  const b = { url: URL, fullText: 'x'.repeat(300), contentTier: 'excerpt' };
  assert.equal(hasTerminalVerdict(a, new Map([['a', a], ['b', b]])), false);
});

test('exact same-URL fetched sibling (text present) exempts the stub', () => {
  const r = assessShow(show, [
    { file: 'a.json', review: canonical },
    { file: 'b.json', review: stub() },
  ], { nowMs });
  assert.equal(r.stranded.length, 0);
});
