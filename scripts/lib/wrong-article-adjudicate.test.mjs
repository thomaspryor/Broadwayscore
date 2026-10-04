// BRO-4603: the daily LLM pass for wrong-article suspects. The verdict may only
// CLEAR a suspect on a real LLM verdict with no wrong-show flags, CONFIRM it on
// a medium/high flag, or leave it failing; it must never clear on a heuristic
// fallback, and 'unsure' must stay unrecorded so the next run retries it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { adjudicationFromCv, isClearedByAdjudication, adjudicateSuspects } = createRequire(import.meta.url)('./wrong-article-adjudicate.js');

const llm = (o) => ({ verifiedBy: 'llm:claude-opus-4-7', isValid: true, wrongArticle: false, wrongProduction: false, isFilmTv: false, confidence: 'high', reasoning: 'r', ...o });

test('adjudicationFromCv: clean LLM verdict clears; flags confirm; anything else is unsure', () => {
  assert.equal(adjudicationFromCv(llm({})).verdict, 'same-show');
  // Truncation / isValid:false is not a different show.
  assert.equal(adjudicationFromCv(llm({ isValid: false, truncated: true })).verdict, 'same-show');
  assert.equal(adjudicationFromCv(llm({ wrongArticle: true })).verdict, 'wrong-article');
  assert.equal(adjudicationFromCv(llm({ wrongProduction: true, confidence: 'medium' })).verdict, 'wrong-article');
  assert.equal(adjudicationFromCv(llm({ wrongProduction: true, confidence: 'low' })).verdict, 'unsure');
  assert.equal(adjudicationFromCv(llm({ isFilmTv: true })).verdict, 'unsure');
});

test('adjudicationFromCv: never clears on a heuristic fallback or missing result', () => {
  assert.equal(adjudicationFromCv({ verifiedBy: 'heuristic', isValid: true, wrongArticle: false, wrongProduction: false }).verdict, 'unsure');
  assert.equal(adjudicationFromCv(null).verdict, 'unsure');
  assert.equal(adjudicationFromCv({}).verdict, 'unsure');
});

test('isClearedByAdjudication: only a same-show verdict for the SAME text hash clears', () => {
  assert.equal(isClearedByAdjudication({ hash: 'abc', verdict: 'same-show' }, 'abc'), true);
  assert.equal(isClearedByAdjudication({ hash: 'abc', verdict: 'same-show' }, 'def'), false, 'edited text must re-surface');
  assert.equal(isClearedByAdjudication({ hash: 'abc', verdict: 'wrong-article' }, 'abc'), false);
  assert.equal(isClearedByAdjudication(undefined, 'abc'), false);
});

test('adjudicateSuspects: records clear/confirm, skips unsure, keeps existing, honours max and hashes', async () => {
  const shows = new Map([['s1', { id: 's1', title: 'S One' }], ['s2', { id: 's2', title: 'S Two' }]]);
  const reviews = {
    's1/a.json': { fullText: 'x'.repeat(2000), url: 'u1' },
    's1/b.json': { fullText: 'y'.repeat(2000), url: 'u2' },
    's2/c.json': { fullText: 'z'.repeat(2000), url: 'u3' },
    's2/d.json': { fullText: 'w'.repeat(2000), url: 'u4' },
  };
  const verdicts = { u1: llm({}), u2: llm({ wrongArticle: true }), u3: { verifiedBy: 'heuristic' } };
  const asked = [];
  const { adjudicated, attempted, counts } = await adjudicateSuspects({
    suspects: [
      { file: 's1/a.json', hash: 'h1' },
      { file: 's1/b.json', hash: 'h2' },
      { file: 's2/c.json', hash: 'h3' },
      { file: 'old/e.json', hash: 'h5' }, // already adjudicated for this hash → not asked again
      { file: 's2/d.json', hash: 'h4' }, // beyond max
    ],
    shows,
    model: 'm',
    max: 3,
    existing: { 'old/e.json': { hash: 'h5', verdict: 'same-show' }, 'gone/f.json': { hash: 'h6', verdict: 'same-show' } },
    readReview: (f) => reviews[f] || null,
    verify: async ({ review }) => { asked.push(review.url); return verdicts[review.url]; },
    now: () => 'T',
  });
  assert.deepEqual(asked, ['u1', 'u2', 'u3']);
  assert.equal(attempted, 3);
  assert.deepEqual(counts, { 'same-show': 1, 'wrong-article': 1, unsure: 1, skipped: 0 });
  assert.equal(adjudicated['s1/a.json'].verdict, 'same-show');
  assert.equal(adjudicated['s1/a.json'].hash, 'h1');
  assert.equal(adjudicated['s1/b.json'].verdict, 'wrong-article');
  assert.equal(adjudicated['s2/c.json'], undefined, 'unsure is not recorded, so the next run retries it');
  assert.ok(adjudicated['gone/f.json'], 'existing entries are never dropped');
});

test('adjudicateSuspects: a throwing verify is unsure, not a crash', async () => {
  const { adjudicated, counts } = await adjudicateSuspects({
    suspects: [{ file: 's1/a.json', hash: 'h1' }],
    shows: new Map([['s1', { title: 'S' }]]),
    readReview: () => ({ fullText: 'x' }),
    verify: async () => { throw new Error('boom'); },
  });
  assert.equal(counts.unsure, 1);
  assert.deepEqual(adjudicated, {});
});
