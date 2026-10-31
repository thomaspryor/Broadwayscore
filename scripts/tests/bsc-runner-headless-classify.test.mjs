// Acceptance test for BRO-4064 — "headless completion signal broken since
// the plain-English ending rule". 48 of 61 headless jobs (2026-09-21..23)
// were journaled job-stopped-short even though they landed, because their
// final chat text moved from `THIS SESSION: ...` to plain English
// ("You can close this tab." etc, CLAUDE.md/BRO-3914) and
// classifyHeadlessResult only understood the legacy syntax.
//
// Per CLAUDE.md §15, every assertion runs the REAL exported classifiers from
// scripts/lib/headless-result-classifier.js and scripts/lib/
// headless-wrapup-block.js — nothing here reimplements the decision logic.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { classifyHeadlessResult } = require(path.join(REPO, 'scripts', 'lib', 'headless-result-classifier.js'));
const { classifyHeadlessJobResult, sessionTranscriptPath, findRecordedWrapupBlock } = require(path.join(REPO, 'scripts', 'lib', 'headless-wrapup-block.js'));

describe('classifyHeadlessResult — plain-English closing lines (BRO-4064)', () => {
  test('"You can close this tab." classifies clean', () => {
    const r = classifyHeadlessResult('Everything landed and verified.\n\nYou can close this tab.');
    assert.deepEqual(r, { outcome: 'clean' });
  });

  test('bare "Keep this tab open." classifies stopped-short with a reason', () => {
    const r = classifyHeadlessResult('Still waiting on CI.\n\nKeep this tab open.');
    assert.equal(r.outcome, 'stopped-short');
    assert.match(r.reason, /never resumed by a background notification/);
  });

  test('real-world "Keep this tab open until X confirms." (BRO-3925 actual wording) still matches the leading phrase', () => {
    const r = classifyHeadlessResult(
      'Ran /code-review on the follow-up fix — zero findings, verdict recorded. Everything is landed and verified except the CI test suite run, which is still in progress in the background.\n\n' +
      'Still running: the CI test suite for the landing commit (I\'ll get notified when it finishes).\nYou need to: nothing.\n\n' +
      'Keep this tab open until that CI check confirms green.'
    );
    assert.equal(r.outcome, 'stopped-short');
  });

  test('"Nothing is running here; keep this tab only if..." classifies clean (maps like legacy IDLE)', () => {
    const r = classifyHeadlessResult(
      'Nothing shipped this turn.\n\nNothing is running here; keep this tab only if you want to continue this topic.'
    );
    assert.deepEqual(r, { outcome: 'clean' });
  });

  test('an emoji/glyph prefix on a plain-English line still matches (same allowance as legacy THIS SESSION:)', () => {
    const r = classifyHeadlessResult('✅ You can close this tab.');
    assert.deepEqual(r, { outcome: 'clean' });
  });
});

describe('classifyHeadlessResult — legacy THIS SESSION: syntax still works (regression)', () => {
  test('legacy "THIS SESSION: CLOSE ME" classifies clean', () => {
    const r = classifyHeadlessResult('All done.\n\nTHIS SESSION: CLOSE ME — landed and verified.');
    assert.deepEqual(r, { outcome: 'clean' });
  });

  test('legacy "THIS SESSION: CLOSE ME — BLOCKED: <reason>" classifies blocked with the reason', () => {
    const r = classifyHeadlessResult('THIS SESSION: CLOSE ME — BLOCKED: need owner to pick option A or B.');
    assert.equal(r.outcome, 'blocked');
    assert.equal(r.reason, 'need owner to pick option A or B.');
  });

  test('legacy "THIS SESSION: KEEP OPEN" classifies stopped-short', () => {
    const r = classifyHeadlessResult('THIS SESSION: KEEP OPEN — waiting on a monitor.');
    assert.equal(r.outcome, 'stopped-short');
  });
});

describe('classifyHeadlessResult — no closing line at all', () => {
  test('plain prose with no THIS SESSION: line and no plain-English template still classifies stopped-short', () => {
    const r = classifyHeadlessResult('I looked into the bug but ran out of time to fix it.');
    assert.equal(r.outcome, 'stopped-short');
    assert.equal(r.reason, 'no THIS SESSION: status line in final result');
  });

  test('empty resultText classifies stopped-short', () => {
    const r = classifyHeadlessResult('');
    assert.equal(r.outcome, 'stopped-short');
  });
});

describe('findRecordedWrapupBlock — WRAPUP_BLOCK_DISABLED kill switch', () => {
  test('set to "1", the reader refuses to look up a block at all, regardless of transcript state', () => {
    const prev = process.env.WRAPUP_BLOCK_DISABLED;
    process.env.WRAPUP_BLOCK_DISABLED = '1';
    try {
      const r = findRecordedWrapupBlock({ cwd: '/fake/cwd', sessionId: 'fake-session' });
      assert.deepEqual(r, { block: null, reason: 'wrapup-block-disabled' });
    } finally {
      if (prev === undefined) delete process.env.WRAPUP_BLOCK_DISABLED;
      else process.env.WRAPUP_BLOCK_DISABLED = prev;
    }
  });
});

describe('sessionTranscriptPath — cwd encoding', () => {
  test('encodes every non-alphanumeric char individually (not collapsing runs), matching real Claude Code project dirs', () => {
    const p = sessionTranscriptPath('/Users/tompryor/Broadwayscore/.claude/worktrees/job-linear-BRO-4064-mudm1aiy', 'abc-123');
    assert.ok(p.endsWith(
      path.join('.claude', 'projects', '-Users-tompryor-Broadwayscore--claude-worktrees-job-linear-BRO-4064-mudm1aiy', 'abc-123.jsonl')
    ), p);
  });
});

describe('classifyHeadlessJobResult — prefers a fresh recorded wrapup-block over plain-English resultText', () => {
  test('a found block classifies from ITS last line, source "wrapup-block", when resultText itself is unparseable (not a contradiction)', () => {
    const r = classifyHeadlessJobResult({
      resultText: 'Landed and verified.', // no closing-line template at all — generic default, not an explicit signal
      sessionId: 'fake-session',
      cwd: '/fake/cwd',
      findBlockFn: () => ({
        block: 'DONE shipped the fix.\nCONTINUING none.\nNEEDS YOU nothing.\nTHIS SESSION: CLOSE ME — landed and verified.',
        reason: 'fresh',
      }),
    });
    assert.equal(r.outcome, 'clean');
    assert.equal(r.source, 'wrapup-block');
  });

  test('no block found falls back to classifying resultText, source "result-text"', () => {
    const r = classifyHeadlessJobResult({
      resultText: 'You can close this tab.',
      sessionId: 'fake-session',
      cwd: '/fake/cwd',
      findBlockFn: () => ({ block: null, reason: 'transcript-not-found' }),
    });
    assert.equal(r.outcome, 'clean');
    assert.equal(r.source, 'result-text');
  });

  test('missing sessionId/cwd skips the block lookup entirely and classifies resultText', () => {
    const r = classifyHeadlessJobResult({ resultText: 'You can close this tab.', sessionId: null, cwd: null });
    assert.equal(r.outcome, 'clean');
    assert.equal(r.source, 'result-text');
  });
});

describe('classifyHeadlessJobResult — a "clean" block does NOT override an explicit contradicting resultText (ship-check finding)', () => {
  test('block says CLOSE ME but the chat text explicitly says "Keep this tab open" — resultText wins, source "result-text-contradicts-block"', () => {
    const r = classifyHeadlessJobResult({
      resultText: 'Keep this tab open until that CI check confirms green.',
      sessionId: 'fake-session',
      cwd: '/fake/cwd',
      findBlockFn: () => ({
        block: 'DONE shipped the fix.\nTHIS SESSION: CLOSE ME — landed and verified.',
        reason: 'fresh',
      }),
    });
    assert.equal(r.outcome, 'stopped-short');
    assert.equal(r.source, 'result-text-contradicts-block');
  });

  test('block says CLOSE ME but the chat text uses legacy "THIS SESSION: ... BLOCKED:" — resultText wins', () => {
    const r = classifyHeadlessJobResult({
      resultText: 'THIS SESSION: CLOSE ME — BLOCKED: needs an owner decision.',
      sessionId: 'fake-session',
      cwd: '/fake/cwd',
      findBlockFn: () => ({
        block: 'DONE shipped the fix.\nTHIS SESSION: CLOSE ME — landed and verified.',
        reason: 'fresh',
      }),
    });
    assert.equal(r.outcome, 'blocked');
    assert.equal(r.source, 'result-text-contradicts-block');
  });

  test('a stopped-short block is never "contradicted" back to clean — resultText only overrides a CLEAN block', () => {
    const r = classifyHeadlessJobResult({
      resultText: 'You can close this tab.',
      sessionId: 'fake-session',
      cwd: '/fake/cwd',
      findBlockFn: () => ({
        block: 'DONE partial.\nTHIS SESSION: KEEP OPEN — waiting on a monitor.',
        reason: 'fresh',
      }),
    });
    assert.equal(r.outcome, 'stopped-short');
    assert.equal(r.source, 'wrapup-block');
  });
});

describe('classifyHeadlessJobResult — findBlockFn is never allowed to crash the classification', () => {
  test('a throwing findBlockFn falls back to classifying resultText instead of propagating', () => {
    const r = classifyHeadlessJobResult({
      resultText: 'You can close this tab.',
      sessionId: 'fake-session',
      cwd: '/fake/cwd',
      findBlockFn: () => { throw new Error('simulated transcript-read failure'); },
    });
    assert.equal(r.outcome, 'clean');
    assert.equal(r.source, 'result-text');
  });
});

// BRO-6314: real final texts from 2026-10-25/26 autofix jobs that finished
// (Paused/In Review with a recheck) but were scored job-stopped-short because
// the closing sentence was not the start of the last line.
describe('classifyHeadlessResult — closing phrase inside the final paragraph (BRO-6314)', () => {
  test('BRO-6311: "Nothing is still running. ... You can close this tab and remove the worktree." is clean', () => {
    const t = 'The Test UGC Features workflow is fixed.\n\nNothing is still running. Nothing is needed from you. You can close this tab and remove the worktree.';
    assert.deepEqual(classifyHeadlessResult(t), { outcome: 'clean' });
  });
  test('BRO-6201: a lone "You can remove the worktree, since ..." closing is clean', () => {
    const t = 'paused, not done.\n\nNothing is running and nothing is needed from you. You can remove the worktree, since its two commits are already on main.';
    assert.deepEqual(classifyHeadlessResult(t), { outcome: 'clean' });
  });
  test('BRO-4695: a trailing "Keep this tab open." still fails safe even after "You can remove the worktree"', () => {
    const t = 'In review.\n\nYou can remove the worktree, since both commits are already on main.\n\nKeep this tab open.';
    assert.equal(classifyHeadlessResult(t).outcome, 'stopped-short');
  });
  test('same paragraph: last phrase wins in both directions', () => {
    assert.equal(classifyHeadlessResult('Nothing is blocked. You can close this tab. Keep this tab open.').outcome, 'stopped-short');
    assert.equal(classifyHeadlessResult('CI is pending, so keep this tab open. You can remove the worktree.').outcome, 'stopped-short');
  });
  test('"Keep the worktree, it holds unfinished work." is stopped-short', () => {
    assert.equal(classifyHeadlessResult('Half done.\n\nKeep the worktree, it holds unfinished work.').outcome, 'stopped-short');
  });
  test('a closing phrase quoted in an EARLIER paragraph does not count', () => {
    assert.equal(classifyHeadlessResult('You can close this tab.\n\nI ran out of time.').outcome, 'stopped-short');
  });
  test('pending decision / conditional close / "but" are never clean (ship-check review)', () => {
    for (const t of [
      'Fixed half of it.\n\nYou need to: answer the question above.\nNothing is running. You can remove the worktree.',
      'DECISION NEEDED: pick A or B. Once you answer, you can close this tab.',
      'Done.\n\nYou can close this tab after CI goes green.',
      'I did not finish. Nothing is running here, but the fix is not pushed.',
      'Fixed half. You can remove the worktree.',
    ]) assert.equal(classifyHeadlessResult(t).outcome, 'stopped-short', t);
    assert.equal(classifyHeadlessResult('Done.\n\nYou need to: nothing. Nothing is running. You can close this tab.').outcome, 'clean');
  });
});

// BRO-6430: real final results from 2026-10-27 jobs (BRO-6423, BRO-6418) put
// the verdict mid-line or before a trailing worktree sentence; 90 of 114
// stopped-short rows in 14d were these.
describe('classifyHeadlessResult — verdict sentence not at the start of the last line (BRO-6430)', () => {
  test('close verdict followed by a worktree sentence on the same line is clean', () => {
    const r = classifyHeadlessResult('The fix is live.\n\nNothing is still running, and nothing is needed from you. You can close this tab. You can remove the worktree.');
    assert.equal(r.outcome, 'clean');
  });
  test('"Keep the worktree" before "You can close this tab." is clean', () => {
    const r = classifyHeadlessResult('Done.\n\nNothing is still running. Nothing is needed from you. Keep the worktree, it holds unfinished work. You can close this tab.');
    assert.equal(r.outcome, 'clean');
  });
  test('keep-open verdict followed by worktree sentence stays stopped-short', () => {
    const r = classifyHeadlessResult('Waiting on CI.\n\nKeep this tab open until CI is green. Keep the worktree, it holds unfinished work.');
    assert.equal(r.outcome, 'stopped-short');
    assert.match(r.reason, /never resumed/);
  });
  test('"Nothing is still running" alone is not a verdict', () => {
    assert.equal(classifyHeadlessResult('Nothing is still running. Nothing is needed from you.').outcome, 'stopped-short');
  });
});

describe('classifyHeadlessResult — closing variants seen in the 14d ledger (BRO-6430)', () => {
  const clean = [
    'Nothing is still running here. You can remove the worktree and close this tab.',
    'Nothing is still running. You can keep the worktree, since it holds the note. This session is idle and can be closed.',
    'Keep the worktree, it holds unfinished work. Keep this tab open only if you want to chase the landing.',
    'Nothing is still running. Keep this tab only if you want to land the follow-up here.',
  ];
  for (const t of clean) test(`clean: ${t.slice(-50)}`, () => assert.equal(classifyHeadlessResult(t).outcome, 'clean'));
  test('"Keep this tab open until you answer." stays stopped-short', () => {
    assert.equal(classifyHeadlessResult('You can remove the worktree. Keep this tab open until you answer.').outcome, 'stopped-short');
  });
});

describe('classifyHeadlessResult — ship-check false-clean guards (BRO-6430)', () => {
  const stopped = [
    'Done. Keep this tab open until CI is green. You can close this tab once that lands.',
    'CI is still queued.\nOnce CI is green you can close this tab.',
    'Still running: the deploy\nKeep this tab open until it is live.\nYou can remove the worktree.',
    'DECISION NEEDED: pick A or B.\nDefault: A.\nNothing else is running.',
    'You can ignore the red deploy and close this tab.',
  ];
  for (const t of stopped) test(`stopped-short: ${t.slice(0, 40).replace(/\n/g, ' ')}`, () => assert.equal(classifyHeadlessResult(t).outcome, 'stopped-short'));
  test('"Keep this tab open only if CI fails." is not idle', () => {
    assert.equal(classifyHeadlessResult('Keep this tab open only if CI fails.').outcome, 'stopped-short');
  });
});

describe('classifyHeadlessResult — codex review guards (BRO-6430)', () => {
  for (const t of [
    'CI is still running. You can close this tab once CI passes.',
    'Do not assume you can close this tab; the deploy is still running.',
    'Nothing else.\nYou can close this tab.\nACTION NEEDED FROM YOU: supply credentials.\nKeep the worktree.',
  ]) test(`stopped-short: ${t.slice(0, 40).replace(/\n/g, ' ')}`, () => assert.equal(classifyHeadlessResult(t).outcome, 'stopped-short'));
});
// BRO-6314: real final texts from 2026-10-25/26 autofix jobs that finished
// (Paused/In Review with a recheck) but were scored job-stopped-short because
// the closing sentence was not the start of the last line.
describe('classifyHeadlessResult — closing phrase inside the final paragraph (BRO-6314)', () => {
  test('BRO-6311: "Nothing is still running. ... You can close this tab and remove the worktree." is clean', () => {
    const t = 'The Test UGC Features workflow is fixed.\n\nNothing is still running. Nothing is needed from you. You can close this tab and remove the worktree.';
    assert.deepEqual(classifyHeadlessResult(t), { outcome: 'clean' });
  });
  test('BRO-6201: a lone "You can remove the worktree, since ..." closing is clean', () => {
    const t = 'paused, not done.\n\nNothing is running and nothing is needed from you. You can remove the worktree, since its two commits are already on main.';
    assert.deepEqual(classifyHeadlessResult(t), { outcome: 'clean' });
  });
  test('BRO-4695: a trailing "Keep this tab open." still fails safe even after "You can remove the worktree"', () => {
    const t = 'In review.\n\nYou can remove the worktree, since both commits are already on main.\n\nKeep this tab open.';
    assert.equal(classifyHeadlessResult(t).outcome, 'stopped-short');
  });
  test('same paragraph: last phrase wins in both directions', () => {
    assert.equal(classifyHeadlessResult('Nothing is blocked. You can close this tab. Keep this tab open.').outcome, 'stopped-short');
    assert.equal(classifyHeadlessResult('CI is pending, so keep this tab open. You can remove the worktree.').outcome, 'stopped-short');
  });
  test('"Keep the worktree, it holds unfinished work." is stopped-short', () => {
    assert.equal(classifyHeadlessResult('Half done.\n\nKeep the worktree, it holds unfinished work.').outcome, 'stopped-short');
  });
  test('a closing phrase quoted in an EARLIER paragraph does not count', () => {
    assert.equal(classifyHeadlessResult('You can close this tab.\n\nI ran out of time.').outcome, 'stopped-short');
  });
  test('pending decision / conditional close / "but" are never clean (ship-check review)', () => {
    for (const t of [
      'Fixed half of it.\n\nYou need to: answer the question above.\nNothing is running. You can remove the worktree.',
      'DECISION NEEDED: pick A or B. Once you answer, you can close this tab.',
      'Done.\n\nYou can close this tab after CI goes green.',
      'I did not finish. Nothing is running here, but the fix is not pushed.',
      'Fixed half. You can remove the worktree.',
    ]) assert.equal(classifyHeadlessResult(t).outcome, 'stopped-short', t);
    assert.equal(classifyHeadlessResult('Done.\n\nYou need to: nothing. Nothing is running. You can close this tab.').outcome, 'clean');
  });
});
