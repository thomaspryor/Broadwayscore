// scripts/tests/verify-edits-cloud-session-gates.test.mjs
//
// End-to-end fixture tests for the two new cloud-only Stop-hook gates added
// to verify-edits.sh (2026-08-23): the session status-line gate (NOSTATUSLINE/
// FALSESAFE) and the PR follow-through gate (PRUNMERGED). Root cause: 8 iOS
// Claude Code sessions in one day left issues unfixed, opened draft PRs and
// asked the (non-technical, PR-review-averse) owner to review them, skipped
// ship-check/wrap-up, and never said whether it was safe to end the session —
// because the local-only ~/.claude/hooks/exit-status-gate.sh and the
// Bash-matcher-only PR/merge gates never fire in cloud sandboxes. See
// .claude/CLOUD.md and cloud-memory/feedback_no_review_offers_user_not_technical.md.
//
// Pattern follows scripts/tests/verify-edits-heredoc.test.mjs exactly: pipe a
// real Stop-hook JSON payload into the REAL hook script over stdin and read
// its exit code (0 = allowed, 2 = BLOCKED) — never a re-embedded copy of the
// Python logic (CLAUDE.md rule 15).
//
// Explicit false-positive coverage is the point of this file (not just
// happy-path blocking): a Stop hook that mis-fires on ordinary conversation
// wedges every future cloud session's ability to end a turn, which is worse
// than the gap it closes. Every BLOCK case here is paired with at least one
// ALLOW case proving the gate doesn't over-fire.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const REAL_HOME = os.homedir();
const HOOK_TIMEOUT_MS = 20_000;

function resolveHookPath() {
  const userHook = path.join(REAL_HOME, '.claude', 'hooks', 'verify-edits.sh');
  if (fs.existsSync(userHook)) return userHook;
  const repoHook = path.join(REPO_ROOT, '.claude', 'hooks', 'verify-edits.sh');
  if (fs.existsSync(repoHook)) return repoHook;
  return null;
}

const HOOK = resolveHookPath();
const skipNoHook = { get skip() { return !HOOK && 'neither ~/.claude/hooks nor the repo .claude/hooks copy of verify-edits.sh is present on this machine'; } };
// This suite specifically targets the NEW cloud-only branches. If a real
// ~/.claude/hooks/verify-edits.sh master exists on this machine (local CLI
// dev box), resolveHookPath() would prefer it — and that master doesn't have
// these branches, so every case here would fail for the wrong reason. Force
// the repo copy via fakeHome so this suite always exercises the code this PR
// actually changed, on any machine.
const REPO_HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'verify-edits.sh');
const skipNoRepoHook = { get skip() { return !fs.existsSync(REPO_HOOK) && 'repo .claude/hooks/verify-edits.sh not found'; } };

function makeTmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verify-edits-cloud-gates-${label}-`));
}

function toolUse(name, input) {
  return { type: 'tool_use', name, id: `tu-${randomUUID()}`, input };
}

// Builds a transcript with an arbitrary sequence of assistant tool_use calls,
// each in its own assistant turn (mirrors real transcripts, where tool calls
// and their results interleave turn-by-turn).
function writeTranscript(dir, toolCalls) {
  const p = path.join(dir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'please do the work' }] } }),
  ];
  for (const call of toolCalls) {
    lines.push(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [call] },
    }));
    lines.push(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'ok' }] },
    }));
  }
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function runHook(transcriptPath, lastAssistantMessage, env = {}) {
  const stdin = JSON.stringify({
    transcript_path: transcriptPath,
    session_id: `veg-test-${randomUUID()}`,
    stop_hook_active: false,
    last_assistant_message: lastAssistantMessage,
  });
  // fakeHome defeats the self-skip preamble so this always runs the REPO copy
  // (the one this PR changed), regardless of what's on the host machine.
  const fakeHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veg-fakehome-'));
  try {
    const r = spawnSync('bash', [REPO_HOOK], {
      input: stdin,
      encoding: 'utf8',
      env: { ...process.env, ...env, HOME: fakeHomeDir },
      timeout: HOOK_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  } finally {
    fs.rmSync(fakeHomeDir, { recursive: true, force: true });
  }
}

function assertBlocked(result, message) {
  assert.equal(result.status, 2, `${message} — expected BLOCKED (exit 2), got exit ${result.status}. stderr: ${result.stderr.slice(0, 400)}`);
}
function assertAllowed(result, message) {
  assert.equal(result.status, 0, `${message} — expected allowed (exit 0), got exit ${result.status}. stderr: ${result.stderr.slice(0, 400)}`);
}

const QUALIFYING_EDIT = toolUse('Edit', { file_path: 'src/lib/scoring.ts', old_string: 'a', new_string: 'b' });
const GIT_PUSH = toolUse('Bash', { command: 'git push -u origin some-branch' });
const CREATE_PR = toolUse('mcp__github__create_pull_request', { owner: 'thomaspryor', repo: 'Broadwayscore', title: 'x', head: 'a', base: 'main' });
const MERGE_PR = toolUse('mcp__github__merge_pull_request', { owner: 'thomaspryor', repo: 'Broadwayscore', pullNumber: 1 });

// ─────────────────────────── status-line gate ────────────────────────────

test('substantial work (code edit) + no closing status line → BLOCKED (NOSTATUSLINE)', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-block-edit');
  const transcript = writeTranscript(dir, [QUALIFYING_EDIT, toolUse('Bash', { command: 'npx tsc --noEmit src/lib/scoring.ts' })]);
  const r = runHook(transcript, 'Fixed the rounding bug and verified with tsc.');
  assertBlocked(r, 'edit+verify but no status line');
  assert.match(r.stderr, /SAFE TO EXIT/, `expected a SAFE TO EXIT reminder, got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('substantial work (git push) + no closing status line → BLOCKED (NOSTATUSLINE)', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-block-push');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const r = runHook(transcript, 'Pushed the branch. Let me know if you want anything else!');
  assertBlocked(r, 'git push but no status line');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('substantial work (git push) + valid SAFE TO EXIT line → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-allow-safe');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const r = runHook(transcript, 'Pushed and verified CI green.\n\nSAFE TO EXIT — branch pushed, CI green, nothing pending.');
  assertAllowed(r, 'valid SAFE TO EXIT line');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('substantial work (git push) + valid NOT SAFE TO EXIT line → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-allow-notsafe');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const r = runHook(transcript, 'Pushed. Deploy still running.\n\nNOT SAFE TO EXIT — deploy still running, will verify next check-in.');
  assertAllowed(r, 'valid NOT SAFE TO EXIT line');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CRITICAL false-positive guard: ordinary conversational turn, no tool calls at all → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-allow-chat');
  const transcript = writeTranscript(dir, []); // no tool calls whatsoever
  const r = runHook(transcript, 'Sure, that repo has 2,800+ shows tracked.');
  assertAllowed(r, 'plain Q&A reply with zero tool calls must never require a status line');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('false-positive guard: mid-task exploratory turn (read-only tools, no edits) → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-allow-explore');
  const transcript = writeTranscript(dir, [
    toolUse('Grep', { pattern: 'foo', path: 'src/' }),
    toolUse('Read', { file_path: 'src/lib/scoring.ts' }),
  ]);
  const r = runHook(transcript, "Found it — scoring.ts:42 is where the tier weight is applied. Want me to change it?");
  assertAllowed(r, 'a research-only turn ending in a question must not require SAFE TO EXIT');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DECISION NEEDED present but message falsely claims SAFE TO EXIT → BLOCKED (FALSESAFE)', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-block-falsesafe');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const msg = [
    'Pushed the fix.',
    '',
    'DECISION NEEDED: should the retry limit be 3 or 5?',
    'Option A — 3: safer default',
    'Option B — 5: matches the old script',
    'My recommendation: Option A',
    '',
    'SAFE TO EXIT — pushed and ready.',
  ].join('\n');
  const r = runHook(transcript, msg);
  assertBlocked(r, 'DECISION NEEDED contradicts SAFE TO EXIT claim');
  assert.match(r.stderr, /DECISION NEEDED/, `expected the contradiction message, got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DECISION NEEDED present with correct NOT SAFE TO EXIT line → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-allow-decision-notsafe');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const msg = [
    'Pushed the fix.',
    '',
    'DECISION NEEDED: should the retry limit be 3 or 5?',
    'My recommendation: 3',
    '',
    'NOT SAFE TO EXIT — answer the DECISION NEEDED above.',
  ].join('\n');
  const r = runHook(transcript, msg);
  assertAllowed(r, 'DECISION NEEDED correctly paired with NOT SAFE TO EXIT');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status-line gate: fenced code block containing SAFE TO EXIT text is stripped, real trailing line still required', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-block-fence-gaming');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const msg = [
    'Pushed. Example of the format for next time:',
    '```',
    'SAFE TO EXIT — example only, not a real status line',
    '```',
    'That\'s all for now.',
  ].join('\n');
  const r = runHook(transcript, msg);
  assertBlocked(r, 'a SAFE TO EXIT string inside a code fence must not satisfy the gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status-line gate: real status line survives when an UNRELATED fenced block precedes it', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-allow-fence-then-real');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const msg = [
    'Pushed. Here is the diff for reference:',
    '```diff',
    '+ SAFE TO EXIT is not a real line here, just diff context',
    '```',
    '',
    'SAFE TO EXIT — pushed, verified, nothing pending.',
  ].join('\n');
  const r = runHook(transcript, msg);
  assertAllowed(r, 'a real status line after an unrelated fence must pass');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status-line gate bypass: NO-VERIFY: in message allows missing status line', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-allow-noverify');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const r = runHook(transcript, 'Pushed a comment-only change. NO-VERIFY: docs-only, no closing status line needed.');
  assertAllowed(r, 'NO-VERIFY bypass must still work');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status-line gate kill switch: SESSION_STATUS_GATE_DISABLE=1 allows missing status line', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-allow-killswitch');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const r = runHook(transcript, 'Pushed.', { SESSION_STATUS_GATE_DISABLE: '1' });
  assertAllowed(r, 'kill switch must fully disable the gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────── PR follow-through gate ───────────────────────

test('PR opened via MCP, never merged, no stated blocker → BLOCKED (PRUNMERGED)', skipNoRepoHook, () => {
  const dir = makeTmpDir('pr-block-unmerged');
  const transcript = writeTranscript(dir, [CREATE_PR]);
  const r = runHook(transcript, "Opened PR #42.\n\nSAFE TO EXIT — PR open, nothing else pending.");
  assertBlocked(r, 'PR opened, never merged, no blocker stated');
  assert.match(r.stderr, /merge it yourself/i, `expected the merge-it-yourself reminder, got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PR opened via MCP AND merged same session → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('pr-allow-merged');
  const transcript = writeTranscript(dir, [CREATE_PR, MERGE_PR]);
  const r = runHook(transcript, "Opened PR #42, CI passed, merged it.\n\nSAFE TO EXIT — merged and live.");
  assertAllowed(r, 'PR opened and merged same session');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PR opened, not merged, but a real blocker (CI red) is stated → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('pr-allow-blocked');
  const transcript = writeTranscript(dir, [CREATE_PR]);
  const r = runHook(transcript, "Opened PR #42 but CI is red on the typecheck job — investigating.\n\nNOT SAFE TO EXIT — CI red on PR #42, fixing next.");
  assertAllowed(r, 'a genuinely stated CI-red blocker must pass');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CRITICAL false-positive guard: no PR tool calls at all → ALLOWED regardless of message content', skipNoRepoHook, () => {
  const dir = makeTmpDir('pr-allow-no-pr');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const r = runHook(transcript, "Pushed directly, no PR needed for this repo's workflow.\n\nSAFE TO EXIT — pushed to branch, no PR opened this session.");
  assertAllowed(r, 'a session that never touched PR tools must never trip the PR gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PR follow-through bypass: NO-VERIFY: allows an unmerged PR', skipNoRepoHook, () => {
  const dir = makeTmpDir('pr-allow-noverify');
  const transcript = writeTranscript(dir, [CREATE_PR]);
  const r = runHook(transcript, "Opened PR #42 for owner sign-off on the pricing change. NO-VERIFY: owner explicitly wants to review this one personally.");
  assertAllowed(r, 'NO-VERIFY bypass must still work for the PR gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PR follow-through kill switch: PR_FOLLOWTHROUGH_GATE_DISABLE=1 allows an unmerged PR', skipNoRepoHook, () => {
  const dir = makeTmpDir('pr-allow-killswitch');
  const transcript = writeTranscript(dir, [CREATE_PR]);
  // Valid status line included deliberately: this case isolates the PR gate's
  // OWN kill switch. Disabling only PR_FOLLOWTHROUGH_GATE_DISABLE must not
  // also bypass the separate, still-active session-status gate — a message
  // with no status line at all would conflate the two gates' kill switches.
  const r = runHook(transcript, 'Opened PR #42.\n\nSAFE TO EXIT — PR open, kill switch test.', { PR_FOLLOWTHROUGH_GATE_DISABLE: '1' });
  assertAllowed(r, 'kill switch must fully disable the PR gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────── regression: existing gates untouched ─────────

test('regression: existing UNVERIFIED gate still blocks an unrun code edit when neither new gate applies', skipNoRepoHook, () => {
  const dir = makeTmpDir('regress-unverified');
  // No git push / PR / substantial-work marker other than the edit itself,
  // and the edit is never verified by a subsequent Bash run — this must
  // still trip the PRE-EXISTING UNVERIFIED:<file> gate, proving the new
  // gates were inserted without disturbing it.
  const transcript = writeTranscript(dir, [QUALIFYING_EDIT]);
  const r = runHook(transcript, 'SAFE TO EXIT — done.'); // valid status line, so the NEW gates pass clean
  assertBlocked(r, 'an unverified code edit must still block on its own pre-existing gate');
  assert.match(r.stderr, /unverified edit/i, `expected the pre-existing UNVERIFIED message, got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('regression: a fully clean session (edit + verify + push + valid status, no PR) → ALLOWED end to end', skipNoRepoHook, () => {
  const dir = makeTmpDir('regress-clean');
  const transcript = writeTranscript(dir, [
    QUALIFYING_EDIT,
    toolUse('Bash', { command: 'npx tsc --noEmit src/lib/scoring.ts' }),
    GIT_PUSH,
  ]);
  const r = runHook(transcript, 'Fixed, verified, pushed.\n\nSAFE TO EXIT — verified with tsc, pushed to branch.');
  assertAllowed(r, 'a fully clean, fully reported session must pass all gates');
  fs.rmSync(dir, { recursive: true, force: true });
});
