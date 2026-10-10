// BRO-4603: the daily LLM pass for wrong-article suspects. The verdict may only
// CLEAR a suspect on a real LLM verdict with no wrong-show flags, CONFIRM it on
// a real flag (or a text that is not a review once junk is stripped), or leave
// it failing. It must never clear on a heuristic fallback, must not let
// repeat-unsure suspects starve never-asked ones, and must not store LLM
// reasoning (it can quote review text; the file is in the public repo).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { adjudicationFromCv, isClearedByAdjudication, needsAsking, adjudicateSuspects, describeConfirmed } = createRequire(import.meta.url)('./wrong-article-adjudicate.js');

const llm = (o) => ({ verifiedBy: 'llm:claude-opus-4-7', isValid: true, truncated: false, wrongArticle: false, wrongProduction: false, isFilmTv: false, confidence: 'high', reasoning: 'r', ...o });

test('adjudicationFromCv: clean verdict clears; truncation is still this show', () => {
  assert.equal(adjudicationFromCv(llm({})).verdict, 'same-show');
  assert.equal(adjudicationFromCv(llm({ isValid: false, truncated: true })).verdict, 'same-show');
});

test('adjudicationFromCv: invalid-but-not-truncated (page junk) never clears', () => {
  assert.equal(adjudicationFromCv(llm({ isValid: false, truncated: false })).verdict, 'unsure');
});

test('adjudicationFromCv: wrongArticle / wrongProduction confirm', () => {
  assert.equal(adjudicationFromCv(llm({ wrongArticle: true })).verdict, 'wrong-article');
  assert.equal(adjudicationFromCv(llm({ wrongProduction: true, confidence: 'medium' })).verdict, 'wrong-article');
  // verifyContent reports wrongProduction's temporally-downgraded confidence
  // whenever wrongProduction is set; it must not hide a wrongArticle flag.
  assert.equal(adjudicationFromCv(llm({ wrongArticle: true, wrongProduction: true, confidence: 'low' })).verdict, 'wrong-article');
  assert.equal(adjudicationFromCv(llm({ wrongArticle: true, confidence: 'low' })).verdict, 'unsure');
  assert.equal(adjudicationFromCv(llm({ wrongProduction: true, confidence: 'low' })).verdict, 'unsure');
  assert.equal(adjudicationFromCv(llm({ isFilmTv: true })).verdict, 'unsure');
});

test('adjudicationFromCv: a text that is not a review once prefixes are stripped is confirmed', () => {
  // The 2026-10-04 Standard JSON-blob "review" reduces to <200 chars.
  assert.equal(adjudicationFromCv({ verifiedBy: 'skip-short', isValid: false, truncated: true }).verdict, 'wrong-article');
});

test('adjudicationFromCv: never clears on a heuristic fallback or missing result', () => {
  assert.equal(adjudicationFromCv({ verifiedBy: 'heuristic', isValid: true }).verdict, 'unsure');
  assert.equal(adjudicationFromCv(null).verdict, 'unsure');
  assert.equal(adjudicationFromCv({}).verdict, 'unsure');
});

test('isClearedByAdjudication: only a same-show verdict for the SAME text hash clears', () => {
  assert.equal(isClearedByAdjudication({ hash: 'abc', verdict: 'same-show' }, 'abc'), true);
  assert.equal(isClearedByAdjudication({ hash: 'abc', verdict: 'same-show' }, 'def'), false, 'edited text must re-surface');
  assert.equal(isClearedByAdjudication({ hash: 'abc', verdict: 'wrong-article' }, 'abc'), false);
  assert.equal(isClearedByAdjudication({ hash: 'abc', verdict: 'unsure' }, 'abc'), false);
  assert.equal(isClearedByAdjudication(undefined, 'abc'), false);
});

test('needsAsking: new text or stale unsure is re-asked; settled verdicts are not', () => {
  const now = Date.parse('2026-10-10T00:00:00Z');
  assert.equal(needsAsking(undefined, 'h', now), true);
  assert.equal(needsAsking({ hash: 'old', verdict: 'same-show' }, 'h', now), true);
  assert.equal(needsAsking({ hash: 'h', verdict: 'same-show' }, 'h', now), false);
  assert.equal(needsAsking({ hash: 'h', verdict: 'wrong-article' }, 'h', now), false);
  assert.equal(needsAsking({ hash: 'h', verdict: 'unsure', at: '2026-10-08T00:00:00Z' }, 'h', now), false);
  assert.equal(needsAsking({ hash: 'h', verdict: 'unsure', at: '2026-10-01T00:00:00Z' }, 'h', now), true);
});

test('adjudicateSuspects: never-asked first, unsure recorded, no free text stored, persisted per entry', async () => {
  const shows = new Map([['s1', { id: 's1', title: 'S One' }], ['s2', { id: 's2', title: 'S Two' }]]);
  const reviews = {
    's1/a.json': { fullText: 'x', url: 'u1' },
    's1/b.json': { fullText: 'y', url: 'u2' },
    's2/c.json': { fullText: 'z', url: 'u3' },
    's2/stale.json': { fullText: 'q', url: 'u5' },
  };
  const verdicts = {
    u1: llm({ reasoning: 'quotes "a line from the review"' }),
    u2: llm({ wrongArticle: true }),
    u3: { verifiedBy: 'heuristic' },
    u5: llm({}),
  };
  const asked = [];
  const persisted = [];
  const { adjudicated, attempted, counts } = await adjudicateSuspects({
    suspects: [
      { file: 's2/stale.json', hash: 'h5' }, // asked before, unsure, stale → eligible but after never-asked ones
      { file: 's1/a.json', hash: 'h1' },
      { file: 's1/b.json', hash: 'h2' },
      { file: 's2/c.json', hash: 'h3' },
      { file: 'done/e.json', hash: 'h6' }, // settled → not asked
    ],
    shows,
    model: 'm',
    max: 3,
    existing: {
      's2/stale.json': { hash: 'h5', verdict: 'unsure', at: '2026-09-01T00:00:00Z' },
      'done/e.json': { hash: 'h6', verdict: 'same-show' },
      'gone/f.json': { hash: 'h7', verdict: 'same-show' },
    },
    readReview: (f) => reviews[f] || null,
    verify: async ({ review }) => { asked.push(review.url); return verdicts[review.url]; },
    now: () => '2026-10-04T12:00:00Z',
    onEntry: (file) => persisted.push(file),
  });
  assert.deepEqual(asked, ['u1', 'u2', 'u3'], 'never-asked suspects take the slots before a stale unsure one');
  assert.equal(attempted, 3);
  assert.deepEqual(counts, { 'same-show': 1, 'wrong-article': 1, unsure: 1, skipped: 0 });
  assert.deepEqual(persisted, ['s1/a.json', 's1/b.json', 's2/c.json']);
  assert.equal(adjudicated['s1/a.json'].verdict, 'same-show');
  assert.equal(adjudicated['s1/b.json'].verdict, 'wrong-article');
  assert.equal(adjudicated['s2/c.json'].verdict, 'unsure');
  assert.equal(adjudicated['s2/c.json'].at, '2026-10-04T12:00:00Z');
  assert.ok(adjudicated['gone/f.json'], 'existing entries are never dropped');
  assert.ok(!JSON.stringify(adjudicated).includes('a line from the review'), 'LLM reasoning must not be stored');
});

test('adjudicateSuspects: a throwing verify is unsure, not a crash', async () => {
  const { adjudicated, counts } = await adjudicateSuspects({
    suspects: [{ file: 's1/a.json', hash: 'h1' }],
    shows: new Map([['s1', { title: 'S' }]]),
    readReview: () => ({ fullText: 'x' }),
    verify: async () => { throw new Error('boom'); },
  });
  assert.equal(counts.unsure, 1);
  assert.equal(adjudicated['s1/a.json'].verdict, 'unsure');
});

test('describeConfirmed: built from stored flags only', () => {
  assert.match(describeConfirmed({ flags: { wrongArticle: true } }), /different article/);
  assert.match(describeConfirmed({ flags: { wrongProduction: true, confidence: 'high' } }), /different production \(high/);
  assert.match(describeConfirmed({ flags: {} }), /not a review/);
});
