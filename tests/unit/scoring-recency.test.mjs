/**
 * BRO-4770: a stale whole-file winner must not revert a newer rescore.
 * Incident: slam-frank 1 Minute Critic, anchored rescore 57f1aab90 reverted by
 * gather commit c7aa1d3f7 (67-minute run on a pre-rescore checkout).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { carryNewerScoring, scoringStamp } = require('../../scripts/lib/scoring-recency.js');
const { reconcileProtectedFields } = require('../../scripts/lib/restore-protected-fields.js');

const BODY = 'Slam Frank takes aim at every ideology in sight. '.repeat(10);

const stale = () => ({
  fullText: BODY + 'longer stale body from gather',
  originalScore: '4/5',
  originalScoreNormalized: 80,
  assignedScore: 80,
  scoreSource: 'llm-v6',
  llmScore: { score: 80 },
  llmMetadata: { scoredAt: '2026-10-05T17:53:58.758Z' },
  needsRescore: true,
  rescoreReason: 'late-star-anchor',
});

const fresh = () => ({
  fullText: BODY,
  originalScore: '4/5',
  originalScoreNormalized: 80,
  assignedScore: 78,
  scoreSource: 'anchored-v6',
  llmScore: { score: 78, band: { floor: 71, ceiling: 90 } },
  llmMetadata: { scoredAt: '2026-10-06T00:16:00.000Z' },
  rescoreCompletedAt: '2026-10-06T00:16:01.000Z',
});

describe('carryNewerScoring', () => {
  test('newer rescore on the other side replaces a stale winner whole-group', () => {
    const winner = { ...stale(), fullText: BODY + 'longer stale body from gather' };
    const other = { ...fresh(), fullText: BODY + 'longer stale body from gather' };
    const r = carryNewerScoring(winner, other);
    assert.equal(r.changed, true);
    assert.equal(winner.scoreSource, 'anchored-v6');
    assert.equal(winner.llmScore.score, 78);
    assert.ok(winner.llmScore.band);
    assert.equal(winner.needsRescore, undefined);
    assert.equal(winner.rescoreReason, undefined);
    assert.ok(winner.rescoreCompletedAt);
    // the winner's own body and star data are untouched
    assert.match(winner.fullText, /longer stale body/);
    assert.equal(winner.originalScoreNormalized, 80);
  });

  test('a flag raised after HEAD\'s rescore survives the push-time carry (BRO-4804)', () => {
    // flaggers delete rescoreCompletedAt, so the staged copy's stamp (scoredAt) is
    // older than HEAD's rescoreCompletedAt even though the flag is newer than both
    const head = { ...fresh(), fullText: BODY };
    const staged = { ...fresh(), fullText: BODY };
    delete staged.rescoreCompletedAt;
    staged.needsRescore = true;
    staged.rescoreReason = 'false-truncation-warning';
    staged.rescoreFlaggedAt = '2026-10-07T05:40:00.000Z';
    const r = carryNewerScoring(staged, head);
    assert.equal(r.changed, false);
    assert.equal(staged.needsRescore, true);
    assert.equal(staged.rescoreReason, 'false-truncation-warning');
    assert.equal(staged.rescoreCompletedAt, undefined);
  });

  test('a flag older than HEAD\'s rescore still loses to it', () => {
    const head = { ...fresh(), fullText: BODY + 'x' };
    const staged = { ...stale(), fullText: BODY + 'x' };
    staged.rescoreFlaggedAt = '2026-10-05T18:00:00.000Z';
    const r = carryNewerScoring(staged, head);
    assert.equal(r.changed, true);
    assert.equal(staged.needsRescore, undefined);
    assert.ok(staged.rescoreCompletedAt);
  });

  test('older other side never overwrites a newer winner', () => {
    const winner = fresh();
    assert.equal(carryNewerScoring(winner, stale()).changed, false);
    assert.equal(winner.scoreSource, 'anchored-v6');
  });

  test('a fresh non-LLM star extraction is not reverted to an older LLM score', () => {
    const winner = { assignedScore: 85, scoreSource: 'extracted', originalScore: '4/5' };
    assert.equal(carryNewerScoring(winner, fresh()).changed, false);
    assert.equal(winner.scoreSource, 'extracted');
  });

  test('deliberate score clear (strip-stale pattern) is never resurrected', () => {
    const winner = { ...stale(), llmScore: null, llmMetadata: null, rescoreCompletedAt: null, fullText: BODY };
    assert.equal(carryNewerScoring(winner, fresh()).changed, false);
    assert.equal(winner.llmScore, null);
  });

  test('different body: newer score carried but re-check queued', () => {
    const winner = stale();
    const r = carryNewerScoring(winner, fresh());
    assert.equal(r.bodyChanged, true);
    assert.equal(winner.needsRescore, true);
    assert.equal(winner.rescoreReason, 'text-changed-after-rescore');
    assert.equal(winner.rescoreCompletedAt, undefined);
    assert.ok(winner.llmScore.band);
  });

  test('same body: rescore completes cleanly, nothing re-queued', () => {
    const winner = { ...stale(), fullText: BODY };
    carryNewerScoring(winner, fresh());
    assert.equal(winner.needsRescore, undefined);
    assert.ok(winner.rescoreCompletedAt);
  });

  test('different star on the two sides: no carry (internally inconsistent)', () => {
    const winner = { ...stale(), originalScore: '3/5', originalScoreNormalized: 60 };
    assert.equal(carryNewerScoring(winner, fresh()).changed, false);
  });

  test('scoringStamp is 0 for unscored and handles bad dates', () => {
    assert.equal(scoringStamp({}), 0);
    assert.equal(scoringStamp({ llmMetadata: { scoredAt: 'nope' } }), 0);
    assert.equal(scoringStamp(null), 0);
  });
});

describe('carry-newer-scoring CLI (bash conflict resolver entry point)', () => {
  test('restores the newer committed rescore onto a stale working file', async () => {
    const { execFileSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'carry-'));
    const sh = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    sh('init', '-q'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
    const body = BODY;
    fs.writeFileSync(pathMod.join(dir, 'r.json'), JSON.stringify({ ...fresh(), fullText: body }));
    sh('add', '.'); sh('commit', '-qm', 'rescore');
    fs.writeFileSync(pathMod.join(dir, 'r.json'), JSON.stringify({ ...stale(), fullText: body }));
    const out = execFileSync('node', [pathMod.resolve('scripts/lib/carry-newer-scoring.js'), '--refs=HEAD', 'r.json'], { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    assert.equal(out.trim().split('\n').pop(), '1');
    const res = JSON.parse(fs.readFileSync(pathMod.join(dir, 'r.json'), 'utf8'));
    assert.equal(res.scoreSource, 'anchored-v6');
    assert.ok(res.llmScore.band);
  });
});

describe('reconcileProtectedFields keeps the newer rescore (stale winner)', () => {
  test('stale local with present-but-old score gets the remote anchored group', () => {
    const local = stale();
    const { modified } = reconcileProtectedFields(local, fresh(), null, { staleCheckoutGuard: true });
    assert.equal(modified, true);
    assert.equal(local.scoreSource, 'anchored-v6');
    assert.ok(local.llmScore.band);
  });

  test('without the stale-checkout guard (local ref callers) scoring is left alone', () => {
    const local = stale();
    reconcileProtectedFields(local, fresh(), null, { staleCheckoutGuard: false });
    assert.equal(local.scoreSource, 'llm-v6');
  });
});
