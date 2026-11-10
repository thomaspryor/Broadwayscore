import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../../scripts/city-hub-audit.js');

test('starBand follows the CLAUDE.md score bands', () => {
  assert.deepEqual(A.starBand(2), [31, 50]);
  assert.deepEqual(A.starBand(4), [71, 90]);
  assert.equal(A.starBand(null), null);
});

test('judgeReview flags wrong production, byline, date drift and star/score mismatch', () => {
  const rev = { criticName: 'Jane Roe', publishDate: '2026-06-01', assignedScore: 85 };
  assert.deepEqual(A.judgeReview(rev, { rightProduction: true, isReview: true, critic: 'Jane Roe', publishDate: '2026-06-02', impliedScore: 80, stars: 4 }), []);
  const p = A.judgeReview(rev, { rightProduction: false, productionSeen: 'Other', isReview: true, critic: 'Bob Smith', publishDate: '2026-07-01', impliedScore: 40, stars: 2 });
  assert.equal(p.length, 5);
  assert.ok(p.some((x) => x.startsWith('wrong production')) && p.some((x) => x.startsWith('critic')) && p.some((x) => x.startsWith('date')) && p.some((x) => x.startsWith('score')) && p.some((x) => x.startsWith('stars')));
  assert.deepEqual(A.judgeReview(rev, { error: 'boom' }), ['model-error boom']);
  // unknown critic on our side is not a byline conflict
  assert.deepEqual(A.judgeReview({ ...rev, criticName: 'unknown' }, { rightProduction: true, isReview: true, critic: 'Bob Smith' }), []);
});

test('quoteProblem checks the pull quote against stored text, tolerating ellipses and curly quotes', () => {
  assert.equal(A.quoteProblem({ pullQuote: 'A frenzied attempt to conceal the musical’s emptiness — but Melanie Moore is fearless' }, "A frenzied attempt to conceal the musical's emptiness. Elsewhere, but Melanie Moore is fearless and good"), null);
  assert.equal(A.quoteProblem({ pullQuote: 'A thing the critic never wrote at all' }, 'something else entirely about the show'), 'pull quote not found in stored text');
  assert.equal(A.quoteProblem({}, ''), null);
});

test('showChecks catches duplicates, missing closing dates/sources, status drift and missing images', () => {
  const mk = (o) => ({ category: 'regional', venue: 'Huntington Theatre Company, Boston, MA', images: { poster: '/nope/x.webp' }, ...o });
  const issues = A.showChecks([
    mk({ id: 'purpose-regional-2026', title: 'Purpose', status: 'closed', openingDate: '2026-09-16', closingDate: '2026-10-11' }),
    mk({ id: 'purpose-huntington-regional-2026', title: 'Purpose', status: 'closed', openingDate: '2026-09-08' }),
    mk({ id: 'x', title: 'Late', status: 'open', openingDate: '2026-01-01', closingDate: '2026-02-01', closingDateSource: 's', venue: 'Elsewhere, MA' }),
  ], '2026-11-10');
  const kinds = issues.map((i) => i.kind);
  for (const k of ['duplicate', 'closing-date-missing', 'closing-source-missing', 'status', 'image-file-missing']) assert.ok(kinds.includes(k), k);
});
