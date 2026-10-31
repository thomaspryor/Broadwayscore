import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { needsEmptyBodyRetry, markEmptyBodyForRetry, recoveryPatch, retryEmptyBodyReviews } = require('./empty-body-retry');
const { createRunBudget } = require('./run-budget');
const show = { id: 'test-show', title: 'Test Show', openingDate: '2026-09-21', category: 'west-end' };
const stub = () => ({ url: 'https://example.com/review', fullText: null, contentTier: 'stub',
  contentTierReason: 'No text content', isFullReview: false, outletId: 'example', criticName: 'Jane Smith' });
const text = 'Test Show is a brilliant play with a remarkable cast. The theatre audience enjoyed the excellent performance and the production is moving. '.repeat(24);
const page = (body = text, date = '2026-09-21') => ({ format: 'html', source: 'cookies-plain',
  content: `<title>Test Show review</title><meta property="article:published_time" content="${date}"><article><p>${body}</p></article>` });

test('only empty, unflagged primary stubs qualify, including whitespace bodies', () => {
  assert.equal(needsEmptyBodyRetry(stub()), true);
  assert.equal(needsEmptyBodyRetry({ ...stub(), fullText: ' \n\t ' }), true);
  for (const patch of [{ fullText: 'actual body' }, { contentTier: 'excerpt' }, { url: '' },
    { wrongProduction: true }, { wrongShow: true }, { isNonReview: true },
    { duplicateOf: 'other.json' }, { duplicateTextOf: 'other.json' }, { isRoundupArticle: true },
    { _locked: true }, { manualContentTier: 'stub' }, { textStatus: 'garbage_cleared' }]) {
    assert.equal(needsEmptyBodyRetry({ ...stub(), ...patch }), false, JSON.stringify(patch));
  }
  assert.equal(needsEmptyBodyRetry({ ...stub(), url: 'https://www.show-score.com/broadway-shows/test-show' }), false);
});

test('the promotion marker makes an empty primary discoverable without changing its score', () => {
  const review = { ...stub(), originalScore: '3/5', assignedScore: 56 };
  markEmptyBodyForRetry(review);
  assert.equal(review.needsTextRetry, true);
  assert.equal(review.assignedScore, 56);
  const complete = { ...stub(), fullText: text, contentTier: 'complete' };
  markEmptyBodyForRetry(complete);
  assert.equal(complete.needsTextRetry, undefined);
  const replay = fs.readFileSync(new URL('../replay-pending-bylines.js', import.meta.url), 'utf8');
  assert.match(replay, /markEmptyBodyForRetry\(data\)/);
  assert.match(replay, /await retryEmptyBodyReviews\(/);
});

test('recovery reclassifies text while rejecting paywalls, wrong shows and prior productions', () => {
  const patch = recoveryPatch(stub(), page(), show, '2026-10-11T00:00:00Z');
  assert.equal(patch.contentTier, 'complete');
  assert.equal(patch.contentTierReason, 'Full review text');
  assert.equal(patch.isFullReview, true);
  assert.equal(patch.textStatus, 'success');
  assert.equal(patch.publishDate, '2026-09-21');
  assert.equal(recoveryPatch(stub(), { content: '' }, show), null);
  assert.equal(recoveryPatch(stub(), page('Subscribe to continue reading.'), show), null);
  assert.equal(recoveryPatch(stub(), page(text.replaceAll('Test Show', 'Other Play')), show), null);
  assert.equal(recoveryPatch(stub(), page(text, '2020-01-01'), show), null);
  assert.equal(recoveryPatch(stub(), page(), null), null);
});

function corpus(t, records) {
  const root = fs.mkdtempSync(path.join(path.resolve('data'), '.bro3999-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, show.id));
  for (const [file, review] of Object.entries(records)) fs.writeFileSync(path.join(root, show.id, file), JSON.stringify(review));
  return { root, read: file => JSON.parse(fs.readFileSync(path.join(root, show.id, file), 'utf8')) };
}

test('sweep reaches landed files with no _pending directory, saves metadata and preserves scores', async t => {
  const { root, read } = corpus(t, { 'empty.json': { ...stub(), originalScore: '3/5', assignedScore: 56 },
    'complete.json': { ...stub(), url: 'https://example.com/other-review', fullText: text, contentTier: 'complete' } });
  let calls = 0;
  const summary = await retryEmptyBodyReviews({ root, shows: [show], isLeased: () => null, log: () => {},
    fetchPage: async url => { calls++; assert.equal(url, stub().url); return page(); } });
  assert.equal(summary.recovered, 1);
  assert.equal(calls, 1);
  const saved = read('empty.json');
  assert.equal(saved.fullText, text.trim());
  assert.equal(saved.contentTier, 'complete');
  assert.equal(saved.needsTextRetry, false);
  assert.equal(saved.fetchMethod, 'cookies-plain');
  assert.equal(saved.originalScore, '3/5');
  assert.equal(saved.assignedScore, 56);
  assert.equal(read('complete.json').fullText, text);
});

test('failures checkpoint a cooldown and limits rotate through the backlog', async t => {
  const { root, read } = corpus(t, { 'a.json': stub(), 'b.json': { ...stub(), url: 'https://example.com/second-review' } });
  const now = () => Date.parse('2026-10-11T00:00:00Z');
  let calls = 0;
  const options = { root, shows: [show], now, limit: 1, isLeased: () => null, log: () => {},
    fetchPage: async () => { calls++; throw new Error('failed'); } };
  const first = await retryEmptyBodyReviews(options);
  assert.equal(first.attempted, 1);
  assert.equal(first.failed, 1);
  assert.equal(first.deferred, 1);
  assert.equal(read('a.json').needsTextRetry, true);
  assert.equal(read('a.json').fullText, null);
  const second = await retryEmptyBodyReviews(options);
  assert.equal(second.attempted, 1);
  assert.ok(read('b.json').textRetryAttemptedAt);
  assert.equal((await retryEmptyBodyReviews(options)).attempted, 0);
  assert.equal(calls, 2);
});

test('dry run, expired budget, explicit scope and leases make no fetches or writes', async t => {
  const { root, read } = corpus(t, { 'empty.json': stub() });
  const options = { root, shows: [show], log: () => {}, isLeased: () => null,
    fetchPage: async () => { assert.fail('must not fetch'); } };
  assert.equal((await retryEmptyBodyReviews({ ...options, dryRun: true })).recovered, 0);
  assert.deepEqual(read('empty.json'), stub());
  assert.equal((await retryEmptyBodyReviews({ ...options, showIds: [] })).candidates, 0);
  assert.equal((await retryEmptyBodyReviews({ ...options, isLeased: () => ({ holder: 'other' }) })).candidates, 0);
  let ms = 0;
  const budget = createRunBudget(1, () => ms);
  ms = 60000;
  assert.equal((await retryEmptyBodyReviews({ ...options, budget })).attempted, 0);
});

test('a concurrent verdict or recovery during fetch is preserved', async t => {
  const { root, read } = corpus(t, { 'empty.json': stub() });
  await retryEmptyBodyReviews({ root, shows: [show], log: () => {}, isLeased: () => null,
    fetchPage: async () => {
      fs.writeFileSync(path.join(root, show.id, 'empty.json'), JSON.stringify({ ...stub(), wrongShow: true }));
      return page();
    } });
  assert.equal(read('empty.json').wrongShow, true);
  assert.equal(read('empty.json').fullText, null);
});

test('the canonical write guard prevents spending on an unmarked duplicate', async t => {
  const { root, read } = corpus(t, { 'empty.json': stub(),
    'complete.json': { ...stub(), fullText: text, contentTier: 'complete' } });
  await retryEmptyBodyReviews({ root, shows: [show], log: () => {}, isLeased: () => null,
    fetchPage: async () => { assert.fail('duplicate must not fetch'); } });
  assert.equal(read('empty.json').duplicateOf, 'complete.json');
  assert.equal(read('empty.json').fullText, null);
});
