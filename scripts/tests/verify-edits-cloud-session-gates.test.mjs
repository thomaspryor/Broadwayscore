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

// `result` is the tool_result text the hook will see for this call (default
// 'ok'). The card-first and close-out gates key on the CLI's own success
// output, so those fixtures need a realistic result, not a placeholder.
function toolUse(name, input, result = 'ok') {
  return { type: 'tool_use', name, id: `tu-${randomUUID()}`, input, _result: result };
}

// What `linear-brain.js create` really prints: stdout JSON + stderr marker.
const CARD_CREATE = toolUse(
  'Bash',
  { command: 'node scripts/linear-brain.js create "Fix the thing" --dispatch --notes "## Acceptance criteria\\n`npx tsc --noEmit`"' },
  '{\n  "identifier": "BRO-9001",\n  "url": "https://linear.app/x/issue/BRO-9001"\n}\n__BOARD_CARD_ID__=BRO-9001\nISSUE-FILED: BRO-9001',
);

// Builds a transcript with an arbitrary sequence of assistant tool_use calls,
// each in its own assistant turn (mirrors real transcripts, where tool calls
// and their results interleave turn-by-turn). Every fixture files a Linear
// card first (CLAUDE.md §6) unless `card: false` — so the card-first gate
// stays out of the way of tests about the other gates.
function writeTranscript(dir, toolCalls, { card = true, userText = 'please do the work' } = {}) {
  const p = path.join(dir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: userText }] } }),
  ];
  for (const { _result, ...call } of card ? [CARD_CREATE, ...toolCalls] : toolCalls) {
    lines.push(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [call] },
    }));
    lines.push(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: _result ?? 'ok' }] },
    }));
  }
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

// The board gates (NOCARD/NOWRAPUP) call `node scripts/linear-brain.js --probe`
// under $CLAUDE_PROJECT_DIR before blocking, and fail open unless it exits 0.
// A stub repo root keeps the tests offline and deterministic; STUB_PROBE_EXIT
// picks the verdict (0 healthy / 3 erroring / 4 unreachable).
const STUB_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'veg-stubroot-'));
fs.mkdirSync(path.join(STUB_ROOT, 'scripts'));
fs.writeFileSync(path.join(STUB_ROOT, 'scripts', 'linear-brain.js'), 'process.exit(Number(process.env.STUB_PROBE_EXIT || 0));\n');

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
      env: { ...process.env, CLAUDE_PROJECT_DIR: STUB_ROOT, BOARD_GATE_DISABLED: '0', ...env, HOME: fakeHomeDir },
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
const WRAP_UP = toolUse('Skill', { skill: 'wrap-up' });
// A real Notion close-out call in the shape this repo actually uses (see
// scripts/notion-brain.js's own usage header: `update <page-id> [--status
// Done] [--outcome "..."] ...`). Kept as separate Done/Paused/In-progress
// variants because the whole point of the redesign below is that the
// STATUS VALUE, not just the presence of a notion-brain.js call, is what
// satisfies the gate.
const NOTION_CLOSEOUT_DONE = toolUse('Bash', { command: 'node scripts/notion-brain.js update 3c5637c5-416f-81a0-bd7e-c388c5673dc5 --status="Done" --outcome="Shipped and verified."' });
const NOTION_CLOSEOUT_PAUSED = toolUse('Bash', { command: 'node scripts/notion-brain.js update 3c5637c5-416f-81a0-bd7e-c388c5673dc5 --status "Paused" --notes "Blocked on owner decision."' });
const NOTION_UPDATE_IN_PROGRESS = toolUse('Bash', { command: 'node scripts/notion-brain.js update 3c5637c5-416f-81a0-bd7e-c388c5673dc5 --status="In progress" --outcome="Still working on this."' });

// ─────────────────────────── wrap-up-close-out gate ────────────────────────
// Root cause (v1): a real session's final message read "SAFE TO EXIT — fix
// confirmed live in production, nothing outstanding" — a perfectly formatted
// status line — but when the owner directly asked "did you run /wrap-up and
// /what-else?" the session admitted it had run neither. The status-line gate
// only checks the LINE'S TEXT SHAPE; these cases prove it can't be gamed by a
// well-formatted lie.
//
// Root cause (v2 — this redesign): v1 required a `Skill(wrap-up)` tool_use,
// which the owner correctly rejected as a token-gesture check — invoking the
// skill doesn't prove any of its mandatory phases actually happened. The
// redesign instead requires the concrete artifact CLAUDE.md §6 independently
// mandates: this session's Notion card actually set to Done/Paused. Cases
// below cover both the original "no close-out at all" failure mode AND the
// new failure modes a plan-review pass surfaced: a Skill call with no real
// close-out, a real notion-brain.js call that never actually closes the card
// (still "In progress"), and — the concrete exploit a SECOND /second-opinion
// review found in the first regex-based draft of this redesign — quoted
// example text inside --outcome/--notes that LOOKS like a close-out to a
// naive whole-string regex search but isn't the real --status flag.

test('substantial work + SAFE TO EXIT + no Notion close-out at all → BLOCKED (NOWRAPUP)', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-block-none');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const r = runHook(transcript, 'Pushed and verified live.\n\nSAFE TO EXIT — fix confirmed live in production, nothing outstanding.');
  assertBlocked(r, 'claims SAFE TO EXIT after real work but never closed out the Notion card');
  assert.match(r.stderr, /wrap-up/i, `expected a wrap-up reminder, got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CRITICAL (owner-rejected v1 behavior): Skill(wrap-up) called but NO real Notion close-out → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-block-token-gesture');
  // This is exactly the case the owner called out: invoking the skill alone
  // (a tool-name gesture) must NOT satisfy the gate — only v1 would have
  // passed this. Proves the redesign actually changed behavior, not just
  // its rationale comment.
  const transcript = writeTranscript(dir, [GIT_PUSH, WRAP_UP]);
  const r = runHook(transcript, 'Pushed, then ran /wrap-up.\n\nSAFE TO EXIT — pushed, wrap-up complete, nothing pending.');
  assertBlocked(r, 'invoking the wrap-up skill without a real Notion close-out must no longer satisfy the gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Notion card touched but left "In progress" (not Done/Paused) → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-block-still-in-progress');
  const transcript = writeTranscript(dir, [GIT_PUSH, NOTION_UPDATE_IN_PROGRESS]);
  const r = runHook(transcript, 'Pushed and updated the card.\n\nSAFE TO EXIT — pushed, card updated.');
  assertBlocked(r, 'a notion-brain.js update that never actually closes the card (still In progress) must not satisfy the gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('EXPLOIT REGRESSION (2nd /second-opinion finding): quoted example "--status Done" inside --outcome, real status still In progress → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-block-exploit-quoted-example');
  // The real --status is "In progress"; the --outcome value merely QUOTES
  // the example command `notion-brain.js update <id> --status Done` as
  // documentation text (this repo's own docs do exactly this). A naive
  // regex search across the whole raw command string would have matched
  // "--status Done" inside that quoted text and wrongly passed. The
  // tokenized (shlex) check must only look at the REAL --status flag's
  // value, so this must still block.
  const exploitCmd = toolUse('Bash', {
    command: 'node scripts/notion-brain.js update 3c5637c5-416f-81a0-bd7e-c388c5673dc5 --status="In progress" --outcome="documented as e.g. notion-brain.js update <id> --status Done for closeout"',
  });
  const transcript = writeTranscript(dir, [GIT_PUSH, exploitCmd]);
  const r = runHook(transcript, 'Pushed and updated the card with docs about the gate.\n\nSAFE TO EXIT — pushed, card updated.');
  assertBlocked(r, 'quoted example text inside --outcome must not satisfy the gate when the real --status is not Done/Paused');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('substantial work + real Notion close-out (Done) AFTER the work + SAFE TO EXIT → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-after');
  const transcript = writeTranscript(dir, [GIT_PUSH, NOTION_CLOSEOUT_DONE]);
  const r = runHook(transcript, 'Pushed, then closed out the Notion card.\n\nSAFE TO EXIT — pushed, Notion card set to Done, nothing pending.');
  assertAllowed(r, 'a genuine Notion close-out after the work it is meant to cover must satisfy the gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('substantial work + real Notion close-out (Paused, space-separated flag form) + SAFE TO EXIT → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-paused-space-form');
  const transcript = writeTranscript(dir, [GIT_PUSH, NOTION_CLOSEOUT_PAUSED]);
  const r = runHook(transcript, 'Pushed, paused the card pending an owner decision.\n\nSAFE TO EXIT — pushed, nothing hanging, card paused with context.');
  assertAllowed(r, 'Paused is a legitimate close-out status too, and the space-separated --status "Paused" form must parse');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('real-world shape: heredoc-wrapped --outcome with apostrophed prose around a real --status=Done → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-heredoc-real');
  // Matches this repo's actual convention (CLAUDE.md's own heredoc
  // commit-message rule, applied the same way to notion-brain.js --outcome
  // values) — multi-line prose via `$(cat <<'EOF' ... EOF)`, including
  // apostrophes that would break a naive shlex.split without heredoc
  // stripping first.
  const heredocCmd = toolUse('Bash', {
    command: [
      'node scripts/notion-brain.js update 3c5637c5-416f-81a0-bd7e-c388c5673dc5 --status="Done" --outcome="$(cat <<\'EOF\'',
      "Shipped the fix. It's done, no loose ends, didn't need anything paused.",
      'EOF',
      ')"',
    ].join('\n'),
  });
  const transcript = writeTranscript(dir, [GIT_PUSH, heredocCmd]);
  const r = runHook(transcript, 'Pushed and wrote up the full outcome.\n\nSAFE TO EXIT — pushed, card closed out.');
  assertAllowed(r, 'a real heredoc-wrapped close-out call (this repo\'s actual convention) must parse and satisfy the gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── composition-seam regression pins (two independent /ship-check reviewers,
// same finding): _strip_heredocs() (built for a different gate, task #1606,
// with a documented KNOWN GAP around quoting/nested-`<<` context) now feeds
// its output into shlex.split() for this gate. Composing two independently
// heuristic parsers is exactly where surprising interaction bugs hide from
// each piece's own isolated test suite — these pin the seam itself, not just
// each piece separately. All three verified against the real hook, not just
// reasoned about.

test('composition seam: single-line --outcome mentioning heredoc syntax as PROSE (no real heredoc) + real Done → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-seam-prose-mention');
  const mentionCmd = toolUse('Bash', {
    command: `node scripts/notion-brain.js update 3c5637c5-416f-81a0-bd7e-c388c5673dc5 --status=Done --outcome="uses a heredoc like <<'EOF' internally"`,
  });
  const transcript = writeTranscript(dir, [GIT_PUSH, mentionCmd]);
  const r = runHook(transcript, 'Pushed and documented it.\n\nSAFE TO EXIT — pushed, card closed out.');
  assertAllowed(r, 'a short --outcome that merely MENTIONS heredoc syntax as text, with no actual multi-line heredoc structure, must still parse to a real Done');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('composition seam: real heredoc body whose OWN prose mentions "<<TAG" on its own line + real Done → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-seam-nested-mention');
  // The exact shape both reviewers flagged as a hypothetical risk: inside a
  // REAL heredoc body, a line that itself looks like it could open another
  // heredoc. _strip_heredocs() only scans for new opens on lines it APPENDS
  // to output (lines outside any currently-open heredoc) — lines being
  // skipped as body content are never re-scanned — so this must not
  // truncate the strip early or corrupt the surrounding --status flag.
  const nestedCmd = toolUse('Bash', {
    command: [
      'node scripts/notion-brain.js update 3c5637c5-416f-81a0-bd7e-c388c5673dc5 --status="Done" --outcome="$(cat <<\'EOF\'',
      'Explaining the fix: heredocs open with <<TAG',
      'EOF',
      ')"',
    ].join('\n'),
  });
  const transcript = writeTranscript(dir, [GIT_PUSH, nestedCmd]);
  const r = runHook(transcript, 'Pushed and documented it.\n\nSAFE TO EXIT — pushed, card closed out.');
  assertAllowed(r, 'a heredoc body that describes heredoc syntax on its own line must not confuse the stripper into corrupting the real --status flag');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('composition seam: unterminated/malformed heredoc → gate fails toward BLOCKED, hook does not crash', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-block-seam-unterminated');
  // A truncated/malformed command (no closing heredoc tag) must not throw an
  // unhandled exception that takes down the whole Stop hook script — it
  // should fail toward "no close-out detected" (block) via the inner
  // try/except in _notion_closeout_status, same as any other unparseable
  // command. Exit code 2 (not e.g. a spawn error / non-2/0 code) is itself
  // proof the process didn't crash.
  const malformedCmd = toolUse('Bash', {
    command: "node scripts/notion-brain.js update abc --status=\"Done\" --outcome=\"$(cat <<'EOF'\nsome unterminated body with no closing tag",
  });
  const transcript = writeTranscript(dir, [GIT_PUSH, malformedCmd]);
  const r = runHook(transcript, 'Pushed.\n\nSAFE TO EXIT — pushed.');
  assertBlocked(r, 'a malformed/unterminated heredoc must fail toward blocking, not crash the hook or silently pass');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CRITICAL gaming case (found by /second-opinion review): close-out happened, then MORE work happened after it, then SAFE TO EXIT → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-block-stale');
  // The close-out happened early, but a second push happened afterward that
  // it never covered — an "anywhere in session" check would wrongly pass
  // this.
  const transcript = writeTranscript(dir, [GIT_PUSH, NOTION_CLOSEOUT_DONE, toolUse('Bash', { command: 'git push -u origin some-branch --force-with-lease' })]);
  const r = runHook(transcript, 'Pushed, closed out, then had to push a follow-up fix.\n\nSAFE TO EXIT — follow-up pushed, nothing pending.');
  assertBlocked(r, 'a stale close-out that happened BEFORE the last substantial work must not satisfy the gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wrap-up gate: NOT SAFE TO EXIT + no close-out → ALLOWED (session has not claimed full completion)', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-notsafe');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const r = runHook(transcript, 'Pushed. Deploy still running.\n\nNOT SAFE TO EXIT — deploy still running, will verify next check-in.');
  assertAllowed(r, 'NOT SAFE TO EXIT does not claim completion, so a close-out is not required yet');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CRITICAL false-positive guard: no substantial work at all → ALLOWED regardless of close-out', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-no-work');
  const transcript = writeTranscript(dir, []);
  const r = runHook(transcript, 'Sure, happy to answer that question.');
  assertAllowed(r, 'a plain conversational reply must never require a Notion close-out');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wrap-up gate bypass: NO-VERIFY: allows a missing close-out', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-noverify');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const r = runHook(transcript, 'Pushed a trivial fix. NO-VERIFY: docs-only, close-out ceremony not needed.\n\nSAFE TO EXIT — pushed.');
  assertAllowed(r, 'NO-VERIFY bypass must still work for the wrap-up gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wrap-up gate kill switch: WRAPUP_GATE_DISABLE=1 allows a missing close-out', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-killswitch');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const r = runHook(transcript, 'Pushed.\n\nSAFE TO EXIT — pushed.', { WRAPUP_GATE_DISABLE: '1' });
  assertAllowed(r, 'kill switch must fully disable the wrap-up gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wrap-up gate: independent of SESSION_STATUS_GATE_DISABLE (no coupling — /second-opinion review finding)', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-block-independent-killswitch');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  // Disabling the STATUS-LINE gate must not also silently disable the
  // wrap-up gate — they are deliberately separate top-level blocks.
  const r = runHook(transcript, 'Pushed.\n\nSAFE TO EXIT — pushed, nothing pending.', { SESSION_STATUS_GATE_DISABLE: '1' });
  assertBlocked(r, 'disabling the status-line gate must not disable the independent wrap-up gate');
  assert.match(r.stderr, /wrap-up/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('regression: a fully clean session (edit + verify + push + Notion close-out + valid status, no PR) → ALLOWED end to end', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-regress-clean');
  const transcript = writeTranscript(dir, [
    QUALIFYING_EDIT,
    toolUse('Bash', { command: 'npx tsc --noEmit src/lib/scoring.ts' }),
    GIT_PUSH,
    NOTION_CLOSEOUT_DONE,
  ]);
  const r = runHook(transcript, 'Fixed, verified, pushed, closed out the card.\n\nSAFE TO EXIT — verified with tsc, pushed, card set to Done.');
  assertAllowed(r, 'a fully clean, fully reported session must pass all gates including the redesigned wrap-up one');
  fs.rmSync(dir, { recursive: true, force: true });
});

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
  const transcript = writeTranscript(dir, [GIT_PUSH, NOTION_CLOSEOUT_DONE]);
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

test('regression (ship-check adversarial review 2026-08-23): canonical wrap-up.md SESSION STATUS block, WITH its trailing divider rule after SAFE TO EXIT, must pass', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-allow-canonical-divider');
  const transcript = writeTranscript(dir, [GIT_PUSH, NOTION_CLOSEOUT_DONE]);
  // Exact shape wrap-up.md specifies: a divider line, DONE/CONTINUING/NEEDS YOU
  // rows, the SAFE TO EXIT line, then ANOTHER divider line below it. Before the
  // fix, checking the literal last non-empty line saw the divider, not the
  // status line, and wrongly BLOCKED every correctly-formatted wrap-up.
  const msg = [
    '──────────────────────────────────────────',
    'DONE        Pushed and verified.',
    'CONTINUING  none',
    'NEEDS YOU   nothing',
    'SAFE TO EXIT — pushed, verified, nothing pending.',
    '──────────────────────────────────────────',
  ].join('\n');
  const r = runHook(transcript, msg);
  assertAllowed(r, 'canonical wrap-up.md block with trailing divider must not be misread as missing a status line');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('regression: trailing divider after NOT SAFE TO EXIT also passes', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-allow-canonical-divider-notsafe');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const msg = [
    '──────────────────────────────────────────',
    'NOT SAFE TO EXIT — deploy still running.',
    '──────────────────────────────────────────',
  ].join('\n');
  const r = runHook(transcript, msg);
  assertAllowed(r, 'canonical NOT SAFE TO EXIT block with trailing divider must pass');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status-line gate still blocks when the real last line is unrelated trailing prose (no divider)', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-block-trailing-prose');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const msg = [
    'SAFE TO EXIT — pushed and verified.',
    '',
    'Let me know if you want anything else!',
  ].join('\n');
  const r = runHook(transcript, msg);
  assertBlocked(r, 'a real trailing sentence after the status line is not a divider and must still block');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('regression (ship-check adversarial review 2026-08-23): empty final message + substantial work → BLOCKED, not silently skipped', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-block-empty-msg');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  // A turn whose last action is a tool call with no closing text has
  // last_assistant_message == '' — this must NOT be treated as "nothing to
  // check" (that would silently defeat the gate on exactly the turn shape
  // most likely to end without a wrap-up in practice).
  const r = runHook(transcript, '');
  assertBlocked(r, 'empty final message after substantial work must still require a status line');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('regression: "DECISION NEEDED" mentioned in prose (not the template header) does not falsely trip FALSESAFE', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-allow-decision-prose');
  const transcript = writeTranscript(dir, [GIT_PUSH, NOTION_CLOSEOUT_DONE]);
  const msg = [
    "There's no DECISION NEEDED here — I already decided retries stay at 3 and pushed it.",
    '',
    'SAFE TO EXIT — decided, pushed, verified.',
  ].join('\n');
  const r = runHook(transcript, msg);
  assertAllowed(r, 'a bare substring mention of the phrase (not the template header) must not trip FALSESAFE');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('regression: PR gate strips fenced quotes too — a quoted example blocker phrase does not satisfy the check', skipNoRepoHook, () => {
  const dir = makeTmpDir('pr-block-fenced-quote-gaming');
  const transcript = writeTranscript(dir, [CREATE_PR]);
  // A valid closing status line is REQUIRED here (found during this session's
  // own /ship-check — a codebase-aware review agent caught it): without one,
  // the earlier session-status-line gate fires first (NOSTATUSLINE) and the
  // test still passes exit-code-wise, but for the wrong reason — it never
  // actually reaches the PR-follow-through gate's own fenced-quote-stripping
  // logic this test claims to isolate.
  const msg = [
    'Opened PR #42. For reference, here is what a blocked run looks like:',
    '```',
    'CI is red on the typecheck job',
    '```',
    "That's just an example from an old run, not this one.",
    '',
    'SAFE TO EXIT — PR open, nothing else pending.',
  ].join('\n');
  const r = runHook(transcript, msg);
  assertBlocked(r, 'a blocker phrase inside a fenced quote must not satisfy the PR follow-through gate');
  assert.match(r.stderr, /land it yourself/i, `expected the PR-follow-through gate's own message (not a different gate's), got: ${r.stderr.slice(0, 300)}`);
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
  const transcript = writeTranscript(dir, [GIT_PUSH, NOTION_CLOSEOUT_DONE]);
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
  assert.match(r.stderr, /land it yourself/i, `expected the land-it-yourself reminder, got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PR opened via MCP AND merged same session → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('pr-allow-merged');
  const transcript = writeTranscript(dir, [CREATE_PR, MERGE_PR, NOTION_CLOSEOUT_DONE]);
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
  const transcript = writeTranscript(dir, [GIT_PUSH, NOTION_CLOSEOUT_DONE]);
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
  const transcript = writeTranscript(dir, [CREATE_PR, NOTION_CLOSEOUT_DONE]);
  // Valid status line included deliberately: this case isolates the PR gate's
  // OWN kill switch. Disabling only PR_FOLLOWTHROUGH_GATE_DISABLE must not
  // also bypass the separate, still-active session-status gate — a message
  // with no status line at all would conflate the two gates' kill switches.
  const r = runHook(transcript, 'Opened PR #42.\n\nSAFE TO EXIT — PR open, kill switch test.', { PR_FOLLOWTHROUGH_GATE_DISABLE: '1' });
  assertAllowed(r, 'kill switch must fully disable the PR gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────── owner never merges: OWNERMERGE / land/** (2026-09-27) ────────────

const LAND_PUSH = toolUse('Bash', { command: 'git push origin HEAD:refs/heads/land/fix-x' });
const LAND_CREATE_BRANCH = toolUse('mcp__github__create_branch', { owner: 'thomaspryor', repo: 'Broadwayscore', branch: 'land/fix-x' });
const LAND_RUN_CHECK = toolUse('mcp__github__actions_list', { method: 'list_workflow_runs', owner: 'thomaspryor', repo: 'Broadwayscore', resource_id: 'land.yml' });
const LINEAR_CLOSEOUT_DONE = toolUse('Bash', { command: 'node scripts/linear-brain.js update BRO-4187 --state Done --comment "landed"' });

test('OWNERMERGE: "waiting on your merge" blocks even with NOT SAFE TO EXIT', skipNoRepoHook, () => {
  const dir = makeTmpDir('ownermerge-block');
  const transcript = writeTranscript(dir, [CREATE_PR]);
  const r = runHook(transcript, "PR #42 is green.\n\nNOT SAFE TO EXIT — PR #42 green, waiting on your merge.");
  assertBlocked(r, 'asking the owner to merge must block');
  assert.match(r.stderr, /owner never merges/i, `got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('OWNERMERGE false-positive guard: describing or quoting the rule is not a merge ask', skipNoRepoHook, () => {
  const dir = makeTmpDir('ownermerge-describe');
  const transcript = writeTranscript(dir, [CREATE_PR, toolUse('Bash', { command: 'git push origin HEAD:refs/heads/land/x' }), toolUse('mcp__github__actions_get', { method: 'get_workflow_run' }), toolUse('Bash', { command: 'node scripts/linear-brain.js update BRO-1 --state Done' })]);
  const r = runHook(transcript, 'Landed. Sessions never ask the owner to merge, and the Stop hook now blocks "waiting on your merge" and `ready to merge`.\n\nSAFE TO EXIT — landed and verified.');
  assertAllowed(r, 'a description or quotation of the rule must not trip OWNERMERGE');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('OWNERMERGE false-positive guard: a real owner decision ("waiting on your decision") is allowed', skipNoRepoHook, () => {
  const dir = makeTmpDir('ownermerge-decision');
  const transcript = writeTranscript(dir, [CREATE_PR]);
  const r = runHook(transcript, "DECISION NEEDED: pricing tier for /biz.\n\nNOT SAFE TO EXIT — waiting on your decision on pricing.");
  assertAllowed(r, 'owner decisions are not merge asks');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('OWNERMERGE false-positive guard: "merge conflict" is a stated blocker, not a merge ask', skipNoRepoHook, () => {
  const dir = makeTmpDir('ownermerge-conflict');
  const transcript = writeTranscript(dir, [CREATE_PR]);
  const r = runHook(transcript, "Resolving it now.\n\nNOT SAFE TO EXIT — merge conflict on PR #42.");
  assertAllowed(r, 'merge conflict must stay a legitimate blocker');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('land/** push + checked Land run + Linear close-out → SAFE TO EXIT allowed (PR gate satisfied)', skipNoRepoHook, () => {
  const dir = makeTmpDir('land-allow');
  const transcript = writeTranscript(dir, [CREATE_PR, LAND_PUSH, LAND_RUN_CHECK, LINEAR_CLOSEOUT_DONE]);
  const r = runHook(transcript, "Landed via land.yml; main fast-forwarded.\n\nSAFE TO EXIT — landed and verified.");
  assertAllowed(r, 'a landed branch satisfies the PR gate, and Linear close-out satisfies wrap-up');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP create_branch land/** counts as landing follow-through', skipNoRepoHook, () => {
  const dir = makeTmpDir('land-mcp');
  const transcript = writeTranscript(dir, [CREATE_PR, LAND_CREATE_BRANCH, LAND_RUN_CHECK, LINEAR_CLOSEOUT_DONE]);
  const r = runHook(transcript, "Landed.\n\nSAFE TO EXIT — landed via MCP land branch.");
  assertAllowed(r, 'MCP land/** branch is the cloud fallback');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('LANDUNCHECKED: land/** push then SAFE TO EXIT without checking the run → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('land-unchecked');
  const transcript = writeTranscript(dir, [CREATE_PR, LAND_PUSH, LINEAR_CLOSEOUT_DONE]);
  const r = runHook(transcript, "Pushed to land.\n\nSAFE TO EXIT — pushed.");
  assertBlocked(r, 'push to land/** is not proof it landed');
  assert.match(r.stderr, /Land run/i, `got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('land/** match is anchored: a branch named foo-land/x is not a landing', skipNoRepoHook, () => {
  const dir = makeTmpDir('land-anchor');
  const transcript = writeTranscript(dir, [CREATE_PR, toolUse('Bash', { command: 'git push origin HEAD:foo-land/x' }), NOTION_CLOSEOUT_DONE]);
  const r = runHook(transcript, "Pushed.\n\nSAFE TO EXIT — pushed.");
  assertBlocked(r, 'foo-land/ is not land/**, PR still unlanded');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────── regression: existing gates untouched ─────────

test('regression: existing UNVERIFIED gate still blocks an unrun code edit when neither new gate applies', skipNoRepoHook, () => {
  const dir = makeTmpDir('regress-unverified');
  // No git push / PR / substantial-work marker other than the edit itself,
  // and the edit is never verified by a subsequent Bash run — this must
  // still trip the PRE-EXISTING UNVERIFIED:<file> gate, proving the new
  // gates were inserted without disturbing it.
  const transcript = writeTranscript(dir, [QUALIFYING_EDIT, NOTION_CLOSEOUT_DONE]);
  const r = runHook(transcript, 'SAFE TO EXIT — done.'); // valid status line + Notion close-out done, so the NEW gates pass clean
  assertBlocked(r, 'an unverified code edit must still block on its own pre-existing gate');
  assert.match(r.stderr, /unverified edit/i, `expected the pre-existing UNVERIFIED message, got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('regression: a fully clean session, standalone check (edit + verify + push + wrap-up + valid status, no PR) → ALLOWED end to end', skipNoRepoHook, () => {
  const dir = makeTmpDir('regress-clean');
  const transcript = writeTranscript(dir, [
    QUALIFYING_EDIT,
    toolUse('Bash', { command: 'npx tsc --noEmit src/lib/scoring.ts' }),
    GIT_PUSH,
    NOTION_CLOSEOUT_DONE,
  ]);
  const r = runHook(transcript, 'Fixed, verified, pushed.\n\nSAFE TO EXIT — verified with tsc, pushed to branch.');
  assertAllowed(r, 'a fully clean, fully reported session must pass all gates');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────── review-parking + bare NOT SAFE TO EXIT (2026-09-28) ────────────
// Session 01Fn6CXk held PR #947 for ~11h ending every turn on "NOT SAFE TO
// EXIT — PR still open and unreviewed". OWNERMERGE only knew merge-asks, and
// PRUNMERGED accepted the bare NOT SAFE TO EXIT line the status gate requires
// on every such turn — so nothing ever fired.

function runOnPr(label, msg, env = {}) {
  const dir = makeTmpDir(label);
  const transcript = writeTranscript(dir, [CREATE_PR]);
  const r = runHook(transcript, msg, env);
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

test('INCIDENT REPLAY: "NOT SAFE TO EXIT — PR still open and unreviewed" → BLOCKED', skipNoRepoHook, () => {
  const r = runOnPr('review-incident', 'Still open, still draft, no new activity.\n\nNOT SAFE TO EXIT — PR #947 still open and unreviewed; next silent check-in at 00:13 UTC.');
  assertBlocked(r, 'parking a PR as "unreviewed" is a review ask');
  assert.match(r.stderr, /never merges or reviews/i, `got: ${r.stderr.slice(0, 300)}`);
});

test('review ask: "ready for your review" → BLOCKED', skipNoRepoHook, () => {
  const r = runOnPr('review-ready-for-your', 'NEEDS YOU — PR #947 is ready for your review.\n\nNOT SAFE TO EXIT — CI still running on PR #947.');
  assertBlocked(r, 'asking the owner to review must block even with a real blocker alongside');
});

test('review ask: "waiting on reviewers" → BLOCKED', skipNoRepoHook, () => {
  const r = runOnPr('review-waiting-reviewers', 'Everything is green.\n\nNOT SAFE TO EXIT — waiting on reviewers for PR #42.');
  assertBlocked(r, '"waiting on reviewers" is a review ask');
});

test('bare NOT SAFE TO EXIT is no longer a stated blocker → BLOCKED (PRUNMERGED)', skipNoRepoHook, () => {
  const r = runOnPr('bare-notsafe', 'Opened PR #42.\n\nNOT SAFE TO EXIT — PR #42 open.');
  assertBlocked(r, 'the status line alone must not satisfy the PR gate');
  assert.match(r.stderr, /land it yourself/i, `got: ${r.stderr.slice(0, 300)}`);
});

test('"draft pending" is no longer a stated blocker → BLOCKED', skipNoRepoHook, () => {
  const r = runOnPr('draft-pending', 'Opened PR #42 as a draft pending follow-up.\n\nNOT SAFE TO EXIT — draft pending.');
  assertBlocked(r, 'a draft is not a blocker');
});

test('CI still running is a legitimate blocker → ALLOWED', skipNoRepoHook, () => {
  const r = runOnPr('ci-running', 'Opened PR #42; test.yml started 1 min ago.\n\nNOT SAFE TO EXIT — CI still running on PR #42, check-in scheduled.');
  assertAllowed(r, 'waiting on a running CI run is legitimate');
});

test('explicit PR-BLOCKER line with a specific reason → ALLOWED', skipNoRepoHook, () => {
  const r = runOnPr('pr-blocker', 'Land refused it.\nPR-BLOCKER: land.yml refused: tsc error in src/lib/scoring.ts:42\n\nNOT SAFE TO EXIT — fixing the tsc error next.');
  assertAllowed(r, 'a specific PR-BLOCKER reason must pass');
});

test('PR-BLOCKER with a throwaway reason (<10 chars) → BLOCKED', skipNoRepoHook, () => {
  const r = runOnPr('pr-blocker-short', 'PR-BLOCKER: wip\n\nNOT SAFE TO EXIT — later.');
  assertBlocked(r, 'a token with no real reason must not satisfy the gate');
});

test('describing the rule in backticks is not a review ask → ALLOWED', skipNoRepoHook, () => {
  const r = runOnPr('review-quoted', 'The gate now blocks `waiting on review` and `unreviewed`.\n\nNOT SAFE TO EXIT — CI still running on PR #42.');
  assertAllowed(r, 'quoted/backticked phrases are dropped before the OWNERMERGE scan');
});

// ─────────────────────────── card-first gate (NOCARD) ───────────────────────
// CLAUDE.md §6: the session files or claims its Linear card first. Session
// 01Fn6CXk edited, pushed and merged a PR without one; the SessionStart banner
// still said notion-brain.js.

function runCard(label, calls, msg, { env = {}, userText } = {}) {
  const dir = makeTmpDir(label);
  const transcript = writeTranscript(dir, calls, { card: false, ...(userText ? { userText } : {}) });
  const r = runHook(transcript, msg, env);
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}
const NOT_SAFE = 'Pushed.\n\nNOT SAFE TO EXIT — deploy still running.';

test('NOCARD: real work (push) with no Linear card → BLOCKED', skipNoRepoHook, () => {
  const r = runCard('nocard-block', [GIT_PUSH], NOT_SAFE);
  assertBlocked(r, 'work without a card must block');
  assert.match(r.stderr, /Linear card/i, `got: ${r.stderr.slice(0, 300)}`);
  assert.doesNotMatch(r.stderr, /notion-brain\.js create/, 'must not send sessions to the retired Notion CLI');
});

test('NOCARD: a code edit alone also needs a card → BLOCKED', skipNoRepoHook, () => {
  const r = runCard('nocard-edit', [QUALIFYING_EDIT, toolUse('Bash', { command: 'npx tsc --noEmit' })], 'Edited and type-checked.\n\nNOT SAFE TO EXIT — not pushed yet.');
  assertBlocked(r, 'editing code is work; the card comes first');
});

test('NOCARD: linear-brain create with its real output → ALLOWED', skipNoRepoHook, () => {
  const r = runCard('nocard-create', [CARD_CREATE, GIT_PUSH], NOT_SAFE);
  assertAllowed(r, 'a created card satisfies the gate');
});

test('NOCARD: create piped through 2>/dev/null (stdout JSON only) → ALLOWED', skipNoRepoHook, () => {
  const create = toolUse('Bash', { command: 'node scripts/linear-brain.js create "x" --dispatch --notes "y" 2>/dev/null' }, '{\n  "identifier": "BRO-9002",\n  "url": "https://linear.app/x"\n}');
  const r = runCard('nocard-create-stdout', [create, GIT_PUSH], NOT_SAFE);
  assertAllowed(r, 'the stdout identifier alone proves the create succeeded');
});

test('NOCARD: linear-session claim of an existing issue → ALLOWED', skipNoRepoHook, () => {
  const claim = toolUse('Bash', { command: 'node scripts/linear-session.js claim --issue=BRO-4201' }, '__LINEAR_ISSUE_ID__=abd2a457-d618-464b-8143-ce2ac3955110\n{"identifier":"BRO-4201","action":"claimed"}');
  const r = runCard('nocard-claim', [claim, GIT_PUSH], NOT_SAFE);
  assertAllowed(r, 'claiming an existing issue satisfies the gate');
});

test('NOCARD: a create that FAILED (no marker in its result) → BLOCKED', skipNoRepoHook, () => {
  const failed = toolUse('Bash', { command: 'node scripts/linear-brain.js create "x" --notes "y"' }, '❌ Card creation must decide: pass --dispatch to work it now, or --park "<reason>".');
  const r = runCard('nocard-create-failed', [failed, GIT_PUSH], NOT_SAFE);
  assertBlocked(r, 'a rejected create is not a card');
});

test('NOCARD spoof guard: grepping the marker out of source does not count → BLOCKED', skipNoRepoHook, () => {
  const grep = toolUse('Bash', { command: 'grep -n "__BOARD_CARD_ID__" scripts/linear-brain.js' }, "646:  console.error(`__BOARD_CARD_ID__=BRO-1`);");
  const r = runCard('nocard-spoof', [grep, GIT_PUSH], NOT_SAFE);
  assertBlocked(r, 'the marker must come from a real create/claim result, not any tool output');
});

test('NOCARD: a BRO-N merely mentioned in user text (e.g. an injected banner) is not a card → BLOCKED, and the message says to claim it', skipNoRepoHook, () => {
  const r = runCard('nocard-mention', [GIT_PUSH], NOT_SAFE, { userText: 'STALE CODE CHECKOUT: a checkout once read a landed commit as reverted (BRO-2663). Work BRO-4201.' });
  assertBlocked(r, 'injected context citing an issue must not satisfy the gate');
  assert.match(r.stderr, /linear-session\.js claim --issue=BRO-N/, `got: ${r.stderr.slice(0, 300)}`);
});

test('NOCARD bypass: NO-CARD with a real reason → ALLOWED; a throwaway one → BLOCKED', skipNoRepoHook, () => {
  assertAllowed(runCard('nocard-bypass', [GIT_PUSH], 'Pushed a typo fix.\nNO-CARD: one-character typo in a comment\n\nNOT SAFE TO EXIT — deploy running.'), 'NO-CARD with a reason');
  assertBlocked(runCard('nocard-bypass-short', [GIT_PUSH], 'Pushed.\nNO-CARD: typo\n\nNOT SAFE TO EXIT — deploy running.'), 'NO-CARD needs 10+ chars');
});

test('NOCARD fails open when Linear is unreachable (probe exit 4) or erroring (exit 3)', skipNoRepoHook, () => {
  const r4 = runCard('nocard-unreachable', [GIT_PUSH], NOT_SAFE, { env: { STUB_PROBE_EXIT: '4' } });
  assertAllowed(r4, 'Linear down → continue untracked (CLAUDE.md §6)');
  assert.match(r4.stderr, /unreachable or erroring/i, 'must warn, not stay silent');
  assertAllowed(runCard('nocard-erroring', [GIT_PUSH], NOT_SAFE, { env: { STUB_PROBE_EXIT: '3' } }), 'erroring (e.g. no LINEAR_API_KEY) also fails open');
});

test('NOCARD honours the board-gate escape hatch and its own kill switch', skipNoRepoHook, () => {
  assertAllowed(runCard('nocard-hatch', [GIT_PUSH], NOT_SAFE, { env: { BOARD_GATE_DISABLED: '1' } }), 'BOARD_GATE_DISABLED=1');
  assertAllowed(runCard('nocard-kill', [GIT_PUSH], NOT_SAFE, { env: { CARD_GATE_DISABLE: '1' } }), 'CARD_GATE_DISABLE=1');
});

test('NOCARD false-positive guard: a read-only turn needs no card → ALLOWED', skipNoRepoHook, () => {
  const r = runCard('nocard-readonly', [toolUse('Read', { file_path: 'src/lib/scoring.ts' })], 'scoring.ts:42 applies the tier weight.');
  assertAllowed(r, 'answering a question is not work');
});

// ─────────────────── wrap-up close-out on Linear (2026-09-28) ───────────────

test('NOWRAPUP: a linear-brain Done that the done-gate REFUSED is not a close-out → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-linear-refused');
  const refused = toolUse('Bash', { command: 'node scripts/linear-brain.js update BRO-9001 --state Done' }, '\n❌ REFUSED — BRO-9001 has no done-evidence (PR-EVIDENCE line or Acceptance criteria).\nExit code 5');
  const transcript = writeTranscript(dir, [GIT_PUSH, refused]);
  const r = runHook(transcript, 'Pushed and closed the card.\n\nSAFE TO EXIT — done.');
  assertBlocked(r, 'the card is still open after a refused update');
  assert.match(r.stderr, /Linear card was never closed out/i, `got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('NOWRAPUP: linear-session report --status=done (claimed issue) → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-linear-report');
  const report = toolUse('Bash', { command: 'node scripts/linear-session.js report --issue=BRO-4201 --status=done --summary="shipped"' }, '__LINEAR_ISSUE_ID__=abc12345-0000\n{"identifier":"BRO-4201","status":"done","stateName":"Done","doneGateRefused":false}');
  const transcript = writeTranscript(dir, [GIT_PUSH, report]);
  const r = runHook(transcript, 'Pushed and reported.\n\nSAFE TO EXIT — reported done.');
  assertAllowed(r, 'report is the close-out verb for a claimed issue');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('NOWRAPUP: linear-session report whose done-gate refused → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-linear-report-refused');
  const report = toolUse('Bash', { command: 'node scripts/linear-session.js report --issue=BRO-4201 --status=done --summary="shipped"' }, '{"identifier":"BRO-4201","status":"done","stateName":"In Progress","doneGateRefused":true}\n❌ REFUSED (no-evidence)');
  const transcript = writeTranscript(dir, [GIT_PUSH, report]);
  const r = runHook(transcript, 'Pushed and reported.\n\nSAFE TO EXIT — reported done.');
  assertBlocked(r, 'a refused report leaves the card open');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('NOWRAPUP fails open when Linear is unreachable', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-linear-down');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const r = runHook(transcript, 'Pushed.\n\nSAFE TO EXIT — pushed.', { STUB_PROBE_EXIT: '4' });
  assertAllowed(r, 'a session cannot close out on a board it cannot reach');
  fs.rmSync(dir, { recursive: true, force: true });
});
