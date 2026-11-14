import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyPath, evaluateInfraReviewGate } = require('../../scripts/lib/infra-review-scope.js');

test('BRO-3408: claude-sync is a critical concurrency path across home spellings', () => {
  for (const path of [
    '/Users/tompryor/.claude/bin/claude-sync',
    '/home/runner/.claude/bin/claude-sync',
    '~/.claude/bin/claude-sync',
    '.claude/bin/claude-sync',
  ]) {
    const classified = classifyPath(path, { repoRoot: '/Users/tompryor/Broadwayscore' });
    assert.equal(classified.inScope, true, path);
    assert.equal(classified.tier, 'critical', path);
    assert.equal(classified.rule, 'concurrency', path);
    assert.equal(classified.why, classifyPath('scripts/lib/push-with-retry.sh').why, path);
  }
});

test('BRO-3408: claude-sync edits require a fresh plan verdict', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const input = {
    paths: ['/Users/tompryor/.claude/bin/claude-sync'],
    repoRoot: '/Users/tompryor/Broadwayscore',
    sessionId: 'bro-3408',
    now,
  };
  const blocked = evaluateInfraReviewGate(input);
  assert.equal(blocked.action, 'block');
  assert.equal(blocked.gated, true);
  assert.equal(blocked.tier, 'critical');

  const allowed = evaluateInfraReviewGate({
    ...input,
    verdicts: [{
      ts: new Date(now - 60_000).toISOString(),
      phase: 'plan',
      reviewer: 'second-opinion',
      result: 'pass',
      sessionId: input.sessionId,
    }],
  });
  assert.equal(allowed.action, 'allow');
});

test('BRO-3408: unrelated bin tools and similarly named files stay outside scope', () => {
  for (const path of [
    '/Users/tompryor/.claude/bin/unrelated-tool',
    '/Users/tompryor/.claude/bin/claude-sync-backup',
    '/Users/tompryor/.claude/bin/claude-sync.sh',
    '/Users/tompryor/.claude/bin/claude-sync/child',
    '/Users/tompryor/.claude/bin/nested/claude-sync',
    '/Users/tompryor/other/bin/claude-sync',
    'bin/claude-sync',
  ]) {
    assert.equal(classifyPath(path).inScope, false, path);
  }
});
