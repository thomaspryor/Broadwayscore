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

// Plain-language approval (no hash transcription required). The human glance is
// the safety; the hash was pointless friction. Negation-guarded.
// The bare-verb cases (Ship all four, push them, send everything) are the ones
// the 2026-05-29 narrow regex missed — see 2026-06-04 incident where the user
// typed "Ship all four" and was forced to transcribe a 16-char hash instead.
for (const phrase of ['approved', 'ship it', 'lgtm', 'looks good', 'yes, approved', 'Yup', 'go ahead and ship it',
  'Ship all four', 'ship all four (Deadline, City Guide, Vanity Fair, Elle)', 'ship them all', 'ship everything',
  'push it', 'push them', 'send everything', 'deploy it', 'good to go', 'all good', 'go for it', 'yeah ship it']) {
  test(`approval-of: accepts plain affirmative "${phrase}"`, () => {
    const { path, cleanup } = writeFixture([
      makeAssistantText('here is the visual — ok to ship?'),
      makeUserText(phrase),
    ]);
    try {
      const r = queryApprovalOf(walkTranscript(path), '6c0949ba442d0357');
      assert.equal(r.approved, true);
      assert.equal(r.via, 'plain-affirmative');
    } finally { cleanup(); }
  });
}

for (const phrase of ["don't ship yet", 'not approved', 'no', 'hold off', 'can we improve the layout first', 'looks good, but fix the mobile padding first', 'yes, wait until tonight', 'approved except change the color']) {
  test(`approval-of: rejects non-approval "${phrase}"`, () => {
    const { path, cleanup } = writeFixture([makeUserText(phrase)]);
    try {
      const r = queryApprovalOf(walkTranscript(path), '6c0949ba442d0357');
      assert.equal(r.approved, false);
    } finally { cleanup(); }
  });
}

test('approval-of: explicit wrong-hash form still rejected (plain path does not leak across verdicts)', () => {
  const { path, cleanup } = writeFixture([
    makeUserText('APPROVED: deadbeefdeadbeef'),
  ]);
  try {
    const r = queryApprovalOf(walkTranscript(path), '6c0949ba442d0357');
    assert.equal(r.approved, false); // hash-qualified → strict; bare-word fallback disabled
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

test('push-ingress: absolute path git (ship-check round-2 P0-2)', () => {
  assert.equal(queryPushIngress('/usr/bin/git push').isPush, true);
  assert.equal(queryPushIngress('/opt/homebrew/bin/git push origin main').isPush, true);
});

test('push-ingress: node/python/ruby script wrappers (round-2 P0-2)', () => {
  assert.equal(queryPushIngress('node scripts/push-to-private-repo.js').isPush, true);
  assert.equal(queryPushIngress('python scripts/push-foo.py').isPush, true);
  assert.equal(queryPushIngress('python3 scripts/push-data.py').isPush, true);
});

test('push-ingress: npm/pnpm/yarn deploy scripts (round-2 P0-2)', () => {
  assert.equal(queryPushIngress('npm run deploy').isPush, true);
  assert.equal(queryPushIngress('pnpm run push').isPush, true);
  assert.equal(queryPushIngress('yarn publish').isPush, true);
});

test('push-ingress: gh pr create --auto (round-2 P0-1)', () => {
  assert.equal(queryPushIngress('gh pr create --auto --merge --squash').isPush, true);
  assert.equal(queryPushIngress('gh pr create --auto-merge').isPush, true);
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

test('visual-claim: SUPPRESSES non-UI false positive (round-2 P1-1)', () => {
  const { path, cleanup } = writeFixture([
    makeAssistantText('The function renders correctly after the refactor.'),
  ]);
  try {
    const r = queryVisualClaimLanguage(walkTranscript(path));
    assert.equal(r.hasClaim, false, 'should NOT trip on non-UI "renders correctly"');
    assert.equal(r.rawClaim, true, 'phrase IS present but UI context absent');
  } finally { cleanup(); }
});

test('visual-claim: STILL fires on UI-context claim (round-2 P1-1)', () => {
  const { path, cleanup } = writeFixture([
    makeAssistantText('The FeaturedSpot card renders correctly on mobile and desktop.'),
  ]);
  try {
    const r = queryVisualClaimLanguage(walkTranscript(path));
    assert.equal(r.hasClaim, true);
    assert.equal(r.inUiContext, true);
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

test('override: REJECTS negated phrase (round-2 P0-3)', () => {
  const { path, cleanup } = writeFixture([
    makeUserText('do NOT ship immediately for: any reason — I want to see screenshots first'),
  ]);
  try {
    const r = queryOverrideActiveForPush(walkTranscript(path), { sessionId: 'sess-neg-test' });
    assert.equal(r.override, false, 'negation must defeat the override');
  } finally { cleanup(); }
});

test('override: REJECTS quoted prose with negation', () => {
  const { path, cleanup } = writeFixture([
    makeUserText("please don't ship immediately for: hotfix — let's review first"),
  ]);
  try {
    const r = queryOverrideActiveForPush(walkTranscript(path), { sessionId: 'sess-quoted-test' });
    assert.equal(r.override, false);
  } finally { cleanup(); }
});

test('override: STILL accepts line-head genuine override (round-2 P0-3 regression guard)', () => {
  const { path, cleanup } = writeFixture([
    makeUserText('ship immediately for: production hotfix'),
  ]);
  const sessionId = 'sess-genuine-test';
  const marker = join(tmpdir(), `visual-qa-override-consumed-${sessionId}`);
  if (existsSync(marker)) unlinkSync(marker);
  try {
    const r = queryOverrideActiveForPush(walkTranscript(path), { sessionId });
    assert.equal(r.override, true);
  } finally {
    if (existsSync(marker)) unlinkSync(marker);
    cleanup();
  }
});

test('override: atomic create — second consumer on race loses (round-2 P1-3)', () => {
  // First consumer claims marker; second sees override=false with race-lost reason.
  const { path, cleanup } = writeFixture([
    makeUserText('ship immediately for: testing the atomic create'),
  ]);
  const sessionId = 'sess-race-test';
  const marker = join(tmpdir(), `visual-qa-override-consumed-${sessionId}`);
  if (existsSync(marker)) unlinkSync(marker);
  try {
    const r1 = queryOverrideActiveForPush(walkTranscript(path), { sessionId, consume: true });
    assert.equal(r1.override, true);
    assert.equal(r1.consumed, true);
    const r2 = queryOverrideActiveForPush(walkTranscript(path), { sessionId, consume: true });
    assert.equal(r2.override, false, 'second consume should see marker and refuse');
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

// ── in-flight NO-VERIFY scoping (S3) ────────────────────────────────────────

function makeAssistantMessageWithTextAndToolUse(messageId, text, toolName, toolInput, toolUseId) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-25T18:00:00Z',
    uuid: messageId,
    message: {
      id: messageId,
      content: [
        { type: 'text', text },
        { type: 'tool_use', name: toolName, input: toolInput, id: toolUseId },
      ],
    },
  });
}

test('visual-claim: in-flight NO-VERIFY in SAME turn as gated tool_use bypasses', () => {
  // First the assistant said something earlier (prior turn — irrelevant).
  // Then the CURRENT turn contains both the NO-VERIFY text AND the Bash push.
  const { path, cleanup } = writeFixture([
    makeAssistantText('Earlier reasoning, no override here.'),
    makeAssistantMessageWithTextAndToolUse(
      'msg-current',
      'Pushing the data-only edit. NO-VERIFY: text-only fix to string array, no visual change.',
      'Bash', { command: 'git push origin HEAD' }, 'tool_push_1',
    ),
  ]);
  try {
    const r = queryVisualClaimLanguage(walkTranscript(path), { toolUseId: 'tool_push_1' });
    assert.equal(r.hasNoVerify, true);
    assert.equal(r.scope, 'in-flight-turn');
  } finally { cleanup(); }
});

test('visual-claim: in-flight scope DOES NOT see prior-turn NO-VERIFY (separated by user msg)', () => {
  // Prior turn had NO-VERIFY. Then user spoke. Then current turn lacks
  // NO-VERIFY. Gate must fire — the prior NO-VERIFY is stale.
  // /ship-check 2026-05-26 widened in-flight scope to "from last user_text
  // to gated tool_use", so the user message marks the turn boundary.
  const { path, cleanup } = writeFixture([
    JSON.stringify({
      type: 'assistant',
      uuid: 'msg-prior',
      message: { id: 'msg-prior', content: [{ type: 'text', text: 'NO-VERIFY: prior turn excuse.' }] },
    }),
    makeUserText('OK, now push the new thing'),
    makeAssistantMessageWithTextAndToolUse(
      'msg-current',
      'Live on production and looks correct on mobile.',
      'Bash', { command: 'git push origin HEAD' }, 'tool_push_2',
    ),
  ]);
  try {
    const r = queryVisualClaimLanguage(walkTranscript(path), { toolUseId: 'tool_push_2' });
    assert.equal(r.hasNoVerify, false);
    assert.equal(r.scope, 'in-flight-turn');
  } finally { cleanup(); }
});

test('visual-claim: falls back to last-text when toolUseId not provided (legacy)', () => {
  const { path, cleanup } = writeFixture([
    makeAssistantText('NO-VERIFY: data-only edit'),
  ]);
  try {
    const r = queryVisualClaimLanguage(walkTranscript(path));
    assert.equal(r.hasNoVerify, true);
    assert.equal(r.scope, 'last-assistant-text');
  } finally { cleanup(); }
});

test('visual-claim: unknown toolUseId falls back to last-text', () => {
  const { path, cleanup } = writeFixture([
    makeAssistantText('NO-VERIFY: fine'),
  ]);
  try {
    const r = queryVisualClaimLanguage(walkTranscript(path), { toolUseId: 'does-not-exist' });
    assert.equal(r.hasNoVerify, true);
    assert.equal(r.scope, 'last-assistant-text');
  } finally { cleanup(); }
});

test('walkTranscript exposes messageId on events', () => {
  const { path, cleanup } = writeFixture([
    makeAssistantMessageWithTextAndToolUse('msg-X', 'hello', 'Bash', { command: 'ls' }, 'tool_1'),
  ]);
  try {
    const events = walkTranscript(path);
    const textEv = events.find(e => e.kind === 'assistant_text');
    const toolEv = events.find(e => e.kind === 'assistant_tool_use');
    assert.equal(textEv.messageId, 'msg-X');
    assert.equal(toolEv.messageId, 'msg-X');
  } finally { cleanup(); }
});

test('in-flight: NO-VERIFY in PRIOR ASSISTANT message (same logical turn, split records) — still bypasses', () => {
  // CC split one logical turn across two assistant records (different
  // message_ids) with no intervening user message. The first carries the
  // NO-VERIFY rationale; the second carries the bash call. Codex P1 + Claude
  // P2-3 (/ship-check 2026-05-26) flagged this as silent-fail under the
  // original strict-messageId logic.
  const { path, cleanup } = writeFixture([
    makeUserText('Please push the fix.'),
    JSON.stringify({
      type: 'assistant',
      uuid: 'msg-current-1',
      message: { id: 'msg-current-1', content: [{ type: 'text', text: 'NO-VERIFY: data-only fix to a string array.' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'msg-current-2',
      message: {
        id: 'msg-current-2',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git push origin HEAD' }, id: 'tool_split' }],
      },
    }),
  ]);
  try {
    const r = queryVisualClaimLanguage(walkTranscript(path), { toolUseId: 'tool_split' });
    assert.equal(r.hasNoVerify, true, 'NO-VERIFY in split assistant message should still bypass');
    assert.equal(r.scope, 'in-flight-turn');
  } finally { cleanup(); }
});

test('in-flight: NO-VERIFY before LAST user msg does NOT bypass (stale)', () => {
  // Assistant said NO-VERIFY two turns ago. Then user said something. Then
  // assistant is now pushing. The NO-VERIFY is stale — different conversation.
  const { path, cleanup } = writeFixture([
    makeAssistantText('NO-VERIFY: stale prior turn'),
    makeUserText('OK, now ship the other thing'),
    JSON.stringify({
      type: 'assistant',
      uuid: 'msg-cur',
      message: {
        id: 'msg-cur',
        content: [
          { type: 'text', text: 'Pushing now.' },
          { type: 'tool_use', name: 'Bash', input: { command: 'git push origin HEAD' }, id: 'tool_stale' },
        ],
      },
    }),
  ]);
  try {
    const r = queryVisualClaimLanguage(walkTranscript(path), { toolUseId: 'tool_stale' });
    assert.equal(r.hasNoVerify, false, 'NO-VERIFY from before last user msg must not bypass');
    assert.equal(r.scope, 'in-flight-turn');
  } finally { cleanup(); }
});
