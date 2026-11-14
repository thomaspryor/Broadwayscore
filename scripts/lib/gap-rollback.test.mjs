// BRO-7171 Stage 4: chrome-gain accepts are rolled back; real recoveries are not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromeRollbackDecision } = require('./gap-rollback.js');
const { sha256 } = require('./gap-acceptance.js');

const BODY = 'The company sings well and the second act moves quickly, though the book sags in places and the staging never quite earns its final image. '.repeat(14).trim();
// shape of the real londonlivinglarge accepts: same review + a sign-up box
const CHROME = ' Sign up to our newsletter Subscribe Share this: Facebook X Email Like this: Like Loading... Related posts Leave a Reply Cancel reply';
const URL = 'https://example.com/review';

function pair(after, { prior = BODY, priorUrl } = {}) {
  const prov = { priorFullTextHash: sha256(prior), priorTextLength: prior.length, priorContentTier: 'truncated', newFullTextHash: sha256(after), method: 'x' };
  if (priorUrl !== undefined) prov.priorUrl = priorUrl;
  return {
    prior: { url: URL, fullText: prior, contentTier: 'truncated', contentTierReason: 'No ending', textWordCount: 300, incompleteReason: 'truncated' },
    current: { url: URL, fullText: after, contentTier: 'truncated', textWordCount: 320, textRecoveryProvenance: prov, llmScore: { score: 70 } },
  };
}

test('chrome-only gain rolls back to the prior text and tier, keeping everything else', () => {
  const { prior, current } = pair(BODY + CHROME);
  const d = chromeRollbackDecision({ current, prior, nowIso: '2026-11-09T00:00:00Z' });
  assert.equal(d.ok, true);
  assert.equal(d.patch.fullText, BODY);
  assert.equal(d.patch.contentTier, undefined, 'tier is left to the rebuild write-back');
  assert.equal(d.patch.textFetchedAt, null, 'prior had no stamp: none is invented, the accept stamp is cleared');
  assert.equal(d.patch.incompleteReason, 'truncated');
  assert.equal(d.patch.llmScore, undefined, 'score fields are not touched');
  assert.equal(d.patch.textRecoveryProvenance.rolledBack.reason, 'chrome_gain');
});

test('the rollback survives a rebase over a CI tier write-back (review-json merge driver; first live run lost 103/105)', () => {
  const { mergeReviewJson } = require('./review-json-three-way-merge.js');
  const { prior, current } = pair(BODY + CHROME);
  prior.textFetchedAt = '2026-10-01T00:00:00Z';
  const base = { ...current, contentTier: 'complete', contentTierReason: 'Full review text', textFetchedAt: '2026-11-08T02:00:00Z' };
  // CI rebuild rewrote the derived tier fields of the accepted (chrome) record
  const upstream = { ...base, contentTierReason: 'Full review text (write-back)', wordCount: 333 };
  const d = chromeRollbackDecision({ current: base, prior, nowIso: '2026-11-09T07:00:00Z' });
  assert.equal(d.ok, true);
  const workflow = { ...base, ...d.patch };
  const { merged } = mergeReviewJson(base, upstream, workflow);
  assert.equal(merged.fullText, BODY, 'restored text wins the merge');
  assert.ok(merged.textRecoveryProvenance.rolledBack);
  assert.equal(merged.textFetchedAt, '2026-10-01T00:00:00Z', 'the restored text keeps its own fetch time');
});

// BRO-7171 leftover: stamping the rollback "now" made restored OLD text look
// like the freshest fetch, so it beat any genuinely newer refetch a CI job
// landed between the accept and the rollback (merge loss). The rollback now
// restores the prior stamp; the merge driver prefers it only over the exact
// chrome text it undoes (provenance.newFullTextHash).
test('rollback restores the prior fetch time and never beats a newer real refetch', () => {
  const { mergeReviewJson, fresherTextWins } = require('./review-json-three-way-merge.js');
  const { prior, current } = pair(BODY + CHROME);
  prior.textFetchedAt = '2026-10-01T00:00:00Z';
  const base = { ...current, textFetchedAt: '2026-11-08T02:00:00Z' };
  const d = chromeRollbackDecision({ current: base, prior, nowIso: '2026-11-09T07:00:00Z' });
  assert.equal(d.patch.textFetchedAt, '2026-10-01T00:00:00Z');
  assert.equal(d.patch.textRecoveryProvenance.rolledBack.at, '2026-11-09T07:00:00Z');
  const workflow = { ...base, ...d.patch };
  // A collector refetched the article after the accept and got a different, real text.
  const REAL = BODY + ' The revival closes with a quiet, devastating final image that the cast earns. '.repeat(3);
  const upstream = { ...base, fullText: REAL, contentTier: 'complete', textFetchedAt: '2026-11-08T20:00:00Z' };
  const { merged } = mergeReviewJson(base, upstream, workflow);
  assert.equal(merged.fullText, REAL, 'a newer real refetch is not overwritten by restored old text');
  // Against the chrome text itself (same hash the provenance names) the rollback wins both ways round.
  const chromeSide = { ...base, textFetchedAt: '2026-11-09T09:00:00Z' };
  assert.equal(fresherTextWins(workflow, chromeSide), 'a');
  assert.equal(fresherTextWins(chromeSide, workflow), 'b');
});

test('stale rollback provenance on a later text never wins the merge', () => {
  const { fresherTextWins } = require('./review-json-three-way-merge.js');
  const { prior, current } = pair(BODY + CHROME);
  const d = chromeRollbackDecision({ current, prior, nowIso: '2026-11-09T07:00:00Z' });
  // Someone later replaced the restored text but kept the provenance.
  const later = { ...current, ...d.patch, fullText: BODY + ' A different later text entirely, not the prior. '.repeat(3), textFetchedAt: '2026-10-02T00:00:00Z' };
  const chromeSide = { ...current, textFetchedAt: '2026-11-09T09:00:00Z' };
  assert.equal(fresherTextWins(later, chromeSide), 'b', 'recency decides once the text is not the restored prior');
});

test('whole-file fallback (merge crashed) keeps the rollback over the longer chrome text', () => {
  const { wholeFileWinner } = require('./review-json-three-way-merge.js');
  const { prior, current } = pair(BODY + CHROME);
  prior.textFetchedAt = '2026-10-01T00:00:00Z';
  const d = chromeRollbackDecision({ current: { ...current, textFetchedAt: '2026-11-08T02:00:00Z' }, prior, nowIso: '2026-11-09T07:00:00Z' });
  const workflow = JSON.stringify({ ...current, ...d.patch });
  const upstream = JSON.stringify({ ...current, textFetchedAt: '2026-11-08T02:00:00Z', wordCount: 333 });
  assert.equal(wholeFileWinner(upstream, workflow), 'workflow');
  assert.equal(wholeFileWinner('{bad json', JSON.stringify({ fullText: 'x' })), 'workflow', 'unparsable side counts as empty');
  assert.equal(wholeFileWinner(JSON.stringify({ fullText: 'abc' }), JSON.stringify({ fullText: 'abc' })), 'upstream', 'tie keeps upstream');
});

test('a stamp whose text was lost in a rebase is retried, not treated as done', () => {
  const p = pair(BODY + CHROME);
  const stamped = { ...p.current, textRecoveryProvenance: { ...p.current.textRecoveryProvenance, rolledBack: { at: 'x' } } };
  assert.equal(chromeRollbackDecision({ current: stamped, prior: p.prior }).ok, true);
});

test('a real recovery (new paragraphs) is never rolled back', () => {
  const more = ' In the second half the director finds a new register, the lighting turns cold and the ensemble moves as one body across the bare stage while the band falls silent. '.repeat(4);
  const { prior, current } = pair(BODY + more);
  const d = chromeRollbackDecision({ current, prior });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'real_new_prose');
});

test('refuses when the text changed since the accept, the url moved, or it was already rolled back', () => {
  const p = pair(BODY + CHROME);
  assert.equal(chromeRollbackDecision({ current: { ...p.current, fullText: BODY + CHROME + ' edited' }, prior: p.prior }).reason, 'text_changed_since_accept');
  const moved = pair(BODY + CHROME, { priorUrl: 'https://example.com/old' });
  assert.equal(chromeRollbackDecision(moved).reason, 'accept_moved_url');
  const done = { ...p.current, fullText: BODY, textRecoveryProvenance: { ...p.current.textRecoveryProvenance, rolledBack: { at: 'x' } } };
  assert.equal(chromeRollbackDecision({ current: done, prior: p.prior }).reason, 'already_rolled_back');
  assert.equal(chromeRollbackDecision({ current: p.current, prior: { ...p.prior, fullText: 'other' } }).reason, 'prior_is_not_the_accepted_prior');
});
