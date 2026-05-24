// scripts/lib/transcript-scan.test.mjs — node:test
// Run: node --test scripts/lib/transcript-scan.test.mjs
//
// Covers all 5 transcript-scan query modes + the override marker-file
// one-shot semantics. Per CLAUDE.md §15 — pure decision functions are
// extracted from the runtime hook scripts so they can be tested in
// isolation; the hook just shells out.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, unlinkSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  walkTranscript,
  queryUiEditsWithoutVerdict,
  queryApprovalOf,
  queryPushIngress,
  queryReferenceAttached,
  queryVisualClaimLanguage,
  queryOverrideActiveForPush,
} from './transcript-scan.mjs';

// ── fixture builders ────────────────────────────────────────────────────────

function makeAssistantToolUse(name, input, id = 'tool_abc') {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-24T18:00:00Z',
    message: { content: [{ type: 'tool_use', name, input, id }] },
  });
}

function makeAssistantText(text) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-24T18:00:00Z',
    message: { content: [{ type: 'text', text }] },
  });
}

function makeUserText(text) {
  return JSON.stringify({
    type: 'user',
    timestamp: '2026-05-24T18:00:00Z',
    message: { content: [{ type: 'text', text }] },
  });
}

function makeUserToolResult(toolUseId, content) {
  return JSON.stringify({
    type: 'user',
    timestamp: '2026-05-24T18:00:00Z',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  });
}

function makeUserImageBlock() {
  return JSON.stringify({
    type: 'user',
    timestamp: '2026-05-24T18:00:00Z',
    message: { content: [{ type: 'image' }] },
  });
}

function writeFixture(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-scan-test-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── walker basics ───────────────────────────────────────────────────────────

test('walkTranscript handles empty file', () => {
  const { path, cleanup } = writeFixture([]);
  try {
    const events = walkTranscript(path);
    assert.deepEqual(events, []);
  } finally { cleanup(); }
});

test('walkTranscript handles truncated last line gracefully', () => {
  const { path, cleanup } = writeFixture([]);
  try {
    writeFileSync(path, makeAssistantText('first') + '\n{"type":"assistant","message":');
    const events = walkTranscript(path);
    // Should yield first event, skip the truncated second
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'assistant_text');
    assert.equal(events[0].text, 'first');
  } finally { cleanup(); }
});

test('walkTranscript yields events in order across types', () => {
  const { path, cleanup } = writeFixture([
    makeUserText('let\'s build a card'),
    makeAssistantText('here we go'),
    makeAssistantToolUse('Edit', { file_path: '/repo/src/foo.tsx' }),
    makeUserToolResult('tool_abc', 'file edited successfully'),
    makeAssistantText('done'),
  ]);
  try {
    const events = walkTranscript(path);
    assert.equal(events.length, 5);
    assert.deepEqual(events.map(e => e.kind), [
      'user_text', 'assistant_text', 'assistant_tool_use', 'tool_result', 'assistant_text',
    ]);
  } finally { cleanup(); }
});

// ── ui-edits-without-verdict ────────────────────────────────────────────────

test('ui-edits: returns hasUiEdit=true for .tsx Edit', () => {
  const { path, cleanup } = writeFixture([
    makeAssistantToolUse('Edit', { file_path: '/repo/src/components/Card.tsx' }),
  ]);
  try {
    const r = queryUiEditsWithoutVerdict(walkTranscript(path));
    assert.equal(r.hasUiEdit, true);
    assert.equal(r.tool, 'Edit');
    assert.ok(r.file_path.endsWith('Card.tsx'));
  } finally { cleanup(); }
});

test('ui-edits: returns hasUiEdit=false for non-UI edits only', () => {
  const { path, cleanup } = writeFixture([
    makeAssistantToolUse('Edit', { file_path: '/repo/README.md' }),
    makeAssistantToolUse('Write', { file_path: '/repo/scripts/foo.js' }),
  ]);
  try {
    const r = queryUiEditsWithoutVerdict(walkTranscript(path));
    assert.equal(r.hasUiEdit, false);
  } finally { cleanup(); }
});

test('ui-edits: returns MOST RECENT when multiple', () => {
  const { path, cleanup } = writeFixture([
    makeAssistantToolUse('Edit', { file_path: '/repo/src/old.tsx' }),
    makeAssistantText('thinking'),
    makeAssistantToolUse('Write', { file_path: '/repo/src/new.css' }),
  ]);
  try {
    const r = queryUiEditsWithoutVerdict(walkTranscript(path));
    assert.equal(r.hasUiEdit, true);
    assert.equal(r.tool, 'Write');
    assert.ok(r.file_path.endsWith('new.css'));
  } finally { cleanup(); }
});

test('ui-edits: tailwind.config.js counted as UI', () => {
  const { path, cleanup } = writeFixture([
    makeAssistantToolUse('Edit', { file_path: '/repo/tailwind.config.js' }),
  ]);
  try {
    const r = queryUiEditsWithoutVerdict(walkTranscript(path));
    assert.equal(r.hasUiEdit, true);
  } finally { cleanup(); }
});

// ── approval-of ─────────────────────────────────────────────────────────────

test('approval-of: matches exact hash in last user msg', () => {
  const { path, cleanup } = writeFixture([
    makeAssistantText('done — APPROVED: abc123 ?'),
    makeUserText('APPROVED: a1b2c3d4e5f6a7b8 looks great'),
  ]);
  try {
    const r = queryApprovalOf(walkTranscript(path), 'a1b2c3d4e5f6a7b8');
    assert.equal(r.approved, true);
  } finally { cleanup(); }
});

test('approval-of: rejects wrong hash even when APPROVED present', () => {
  const { path, cleanup } = writeFixture([
    makeUserText('APPROVED: deadbeef'),
  ]);
  try {
    const r = queryApprovalOf(walkTranscript(path), 'differenthash');
    assert.equal(r.approved, false);
  } finally { cleanup(); }
});

test('approval-of: ignores match in assistant text', () => {
  const { path, cleanup } = writeFixture([
    makeAssistantText('reply with APPROVED: c03cbc58803ec5f9 to ship'),
  ]);
  try {
    const r = queryApprovalOf(walkTranscript(path), 'c03cbc58803ec5f9');
    assert.equal(r.approved, false); // no user msg yet
  } finally { cleanup(); }
});

test('approval-of: checks ONLY last user msg, not stale earlier ones', () => {
  const { path, cleanup } = writeFixture([
    makeUserText('APPROVED: oldHashAaaaaaaaa'),
    makeAssistantText('shipped'),
    makeUserText('now do this other thing'),
  ]);
  try {
    const r = queryApprovalOf(walkTranscript(path), 'oldHashAaaaaaaaa');
    assert.equal(r.approved, false); // stale; last user msg doesn't contain it
  } finally { cleanup(); }
});

// ── push-ingress ────────────────────────────────────────────────────────────

test('push-ingress: matches git push variants', () => {
  for (const cmd of ['git push', 'git push origin main', 'git push -u origin foo', 'git push --force-with-lease']) {
    assert.equal(queryPushIngress(cmd).isPush, true, `failed for: ${cmd}`);
  }
});

test('push-ingress: matches gh pr merge and deploy workflow', () => {
  assert.equal(queryPushIngress('gh pr merge 42 --auto').isPush, true);
  assert.equal(queryPushIngress('gh workflow run "Deploy to Vercel"').isPush, true);
});

test('push-ingress: matches push wrapper scripts', () => {
  assert.equal(queryPushIngress('bash scripts/lib/push-with-retry.sh').isPush, true);
  assert.equal(queryPushIngress('sh scripts/push-data.sh').isPush, true);
});

test('push-ingress: rejects non-push commands', () => {
  for (const cmd of ['git status', 'ls -la', 'git commit -m x', 'gh issue list', 'echo "git push" but only echoing']) {
    const r = queryPushIngress(cmd);
    // The last case "echo \"git push\"" does match — that's a false positive
    // we accept; bash strings echoing the literal "git push" are rare and the
    // hook surfacing a block is recoverable via NO-VERIFY.
    if (cmd.includes('echo')) continue;
    assert.equal(r.isPush, false, `should not match: ${cmd}`);
  }
});

// ── reference-attached ──────────────────────────────────────────────────────

test('reference-attached: detects [Image #N] marker in user text', () => {
  const { path, cleanup } = writeFixture([
    makeUserText('Implement this: [Image #4] [Image #5]'),
  ]);
  try {
    const r = queryReferenceAttached(walkTranscript(path));
    assert.equal(r.attached, true);
  } finally { cleanup(); }
});

test('reference-attached: detects clipboard path in user text', () => {
  const { path, cleanup } = writeFixture([
    makeUserText('design: /var/folders/__/abc/T/clipboard-2026-05-24-132243-foo.png'),
  ]);
  try {
    const r = queryReferenceAttached(walkTranscript(path));
    assert.equal(r.attached, true);
  } finally { cleanup(); }
});

test('reference-attached: detects type=image block', () => {
  const { path, cleanup } = writeFixture([
    makeUserImageBlock(),
  ]);
  try {
    const r = queryReferenceAttached(walkTranscript(path));
    assert.equal(r.attached, true);
  } finally { cleanup(); }
});

test('reference-attached: returns false when no images', () => {
  const { path, cleanup } = writeFixture([
    makeUserText('plain text'),
    makeAssistantText('reply'),
  ]);
  try {
    const r = queryReferenceAttached(walkTranscript(path));
    assert.equal(r.attached, false);
  } finally { cleanup(); }
});

// ── visual-claim-language ──────────────────────────────────────────────────

test('visual-claim: detects "Live on production" without NO-VERIFY', () => {
  const { path, cleanup } = writeFixture([
    makeAssistantText('Live on production. FeaturedSpot card looks great on desktop.'),
  ]);
  try {
    const r = queryVisualClaimLanguage(walkTranscript(path));
    assert.equal(r.hasClaim, true);
  } finally { cleanup(); }
});

test('visual-claim: rejects when NO-VERIFY present in same block', () => {
  const { path, cleanup } = writeFixture([
    makeAssistantText('Live on production. NO-VERIFY: hotfix, dev server cannot start due to data missing.'),
  ]);
  try {
    const r = queryVisualClaimLanguage(walkTranscript(path));
    assert.equal(r.hasClaim, false);
    assert.equal(r.hasNoVerify, true);
  } finally { cleanup(); }
});

test('visual-claim: only checks LAST assistant block', () => {
  const { path, cleanup } = writeFixture([
    makeAssistantText('shipped successfully'),
    makeUserText('cool'),
    makeAssistantText('here is the next step'),
  ]);
  try {
    const r = queryVisualClaimLanguage(walkTranscript(path));
    assert.equal(r.hasClaim, false); // last asst text has no claim
  } finally { cleanup(); }
});

// ── override-active-for-push ───────────────────────────────────────────────

test('override: detects "ship immediately for: <reason>" in last user msg', () => {
  const { path, cleanup } = writeFixture([
    makeUserText('ship immediately for: hotfix at 3am'),
  ]);
  try {
    const r = queryOverrideActiveForPush(walkTranscript(path), { sessionId: 'sess-test-1' });
    // Cleanup any leftover marker first
    const m = join(tmpdir(), 'visual-qa-override-consumed-sess-test-1');
    if (existsSync(m)) unlinkSync(m);
    const r2 = queryOverrideActiveForPush(walkTranscript(path), { sessionId: 'sess-test-1' });
    assert.equal(r2.override, true);
  } finally { cleanup(); }
});

test('override: marker file blocks second use (one-shot)', () => {
  const { path, cleanup } = writeFixture([
    makeUserText('ship immediately for: real reason here'),
  ]);
  const sessionId = 'sess-test-oneshot';
  const marker = join(tmpdir(), `visual-qa-override-consumed-${sessionId}`);
  if (existsSync(marker)) unlinkSync(marker);
  try {
    const r1 = queryOverrideActiveForPush(walkTranscript(path), { sessionId, consume: true });
    assert.equal(r1.override, true);
    assert.equal(r1.consumed, true);
    assert.ok(existsSync(marker), 'marker should be written on consume');
    const r2 = queryOverrideActiveForPush(walkTranscript(path), { sessionId, consume: true });
    assert.equal(r2.override, false, 'second call should not match — marker consumed it');
  } finally {
    if (existsSync(marker)) unlinkSync(marker);
    cleanup();
  }
});

test('override: rejects when no override phrase present', () => {
  const { path, cleanup } = writeFixture([
    makeUserText('just looking at the code'),
  ]);
  try {
    const r = queryOverrideActiveForPush(walkTranscript(path), { sessionId: 'whatever' });
    assert.equal(r.override, false);
  } finally { cleanup(); }
});
