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
