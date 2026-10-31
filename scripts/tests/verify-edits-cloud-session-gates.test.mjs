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

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';

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
function notice(text) {
  return { _notice: text };
}

function attachmentNotice(text) {
  return { _attachment: text };
}

// Every hook run leaves a per-chain loop-guard ledger in /tmp keyed by the
// transcript path (BRO-4367); remove them all when the file finishes.
const WRITTEN_TRANSCRIPTS = new Set();
after(() => {
  for (const t of WRITTEN_TRANSCRIPTS) fs.rmSync(chainFileFor(t), { force: true, recursive: true });
});

function writeTranscript(dir, toolCalls, { card = true, userText = 'please do the work' } = {}) {
  const p = path.join(dir, 'transcript.jsonl');
  WRITTEN_TRANSCRIPTS.add(p);
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: userText }] } }),
  ];
  for (const { _result, _notice, _attachment, _isError, _isMeta, _extra, _userList, ...call } of card ? [CARD_CREATE, ...toolCalls] : toolCalls) {
    if (Array.isArray(_userList)) {
      // An owner message with list content (text + an attached image).
      lines.push(JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: _userList } }));
      continue;
    }
    if (typeof _attachment === 'string') {
      // Mid-turn delivery of the same notices: an `attachment` record with
      // type 'queued_command' and the notice in `prompt` (real shape seen
      // 2026-09-28 for four finished agents that had NO user record at all).
      lines.push(JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: _attachment } }));
      continue;
    }
    if (typeof _notice === 'string') {
      // A harness notice (<task-notification>, <agent-message> hand-back,
      // queued-Routine notice) — and the owner's own typed prompt — is a user
      // record whose content is a plain STRING, not a list. The hook's parser
      // only reads list content for user_text, so a list-shaped fixture here
      // would pass in the harness and fail in production (/second-opinion
      // finding on the in-flight gate, 2026-09-28).
      lines.push(JSON.stringify({ type: 'user', ...(_isMeta ? { isMeta: true } : {}), ...(_extra || {}), message: { role: 'user', content: _notice } }));
      continue;
    }
    lines.push(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [call] },
    }));
    lines.push(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: _result ?? 'ok', ...(_isError ? { is_error: true } : {}) }] },
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

function runHook(transcriptPath, lastAssistantMessage, env = {}, stopHookActive = false) {
  const stdin = JSON.stringify({
    transcript_path: transcriptPath,
    session_id: `veg-test-${randomUUID()}`,
    stop_hook_active: stopHookActive,
    last_assistant_message: lastAssistantMessage,
  });
  // fakeHome defeats the self-skip preamble so this always runs the REPO copy
  // (the one this PR changed), regardless of what's on the host machine.
  const fakeHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veg-fakehome-'));
  try {
    const r = spawnSyncStdinFile('bash', [REPO_HOOK], {
      input: stdin,
      encoding: 'utf8',
      // BRO-5359: the review-coverage gate has its own tests (scripts/lib/review-coverage.test.mjs); these cases model
      // bare Skill calls and must not depend on whether the host session sets CLAUDE_CODE_REMOTE.
      // BRO-5881/BRO-5910: LOOSEENDS, WAKELESS and CLEARCLOSE read every closing message, so the older fixtures (written for
      // other gates) run with them off; their own section below switches them back on.
      env: { ...process.env, CLAUDE_PROJECT_DIR: STUB_ROOT, BOARD_GATE_DISABLED: '0', SHIP_CHECK_COVERAGE_DISABLE: '1', LOOSEENDS_GATE_DISABLE: '1', PASSIVEOFFER_GATE_DISABLE: '1', WAKELESS_GATE_DISABLE: '1', CHILDWAIT_GATE_DISABLE: '1', CLEARCLOSE_GATE_DISABLE: '1', ...env, HOME: fakeHomeDir },
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
// The MCP server's success payload: the gate counts a PR only on its URL (BRO-5915).
const CREATE_PR = toolUse('mcp__github__create_pull_request', { owner: 'thomaspryor', repo: 'Broadwayscore', title: 'x', head: 'a', base: 'main' }, '{"id":"2345","url":"https://github.com/thomaspryor/Broadwayscore/pull/42"}');
// Real success payload of the GitHub MCP merge tool; only this counts as merged.
const MERGE_PR = toolUse('mcp__github__merge_pull_request', { owner: 'thomaspryor', repo: 'Broadwayscore', pullNumber: 1 },
  '{"sha":"0123abc","merged":true,"message":"Pull Request successfully merged"}');
const WRAP_UP = toolUse('Skill', { skill: 'wrap-up' });
// The cloud chain gate (BRO-4238 phase 2): a SAFE TO ARCHIVE after code edits
// needs a review and a /what-else run. "Fully clean" fixtures carry both.
const SHIP_CHECK = toolUse('Skill', { skill: 'ship-check' });
const WHAT_ELSE = toolUse('Skill', { skill: 'what-else' });
// Real Linear close-out calls in the shapes this repo actually uses
// (`linear-brain.js update BRO-N --state <name> [--comment "..."]` and, for a
// claimed issue, `linear-session.js report --issue=BRO-N --status=<x>`). Kept
// as separate Done/Paused/In-progress variants because the whole point of the
// gate is that the STATE VALUE, not just the presence of a board call, is
// what satisfies it. (These were notion-brain.js calls until BRO-4274 retired
// Notion as a close-out; NOTION_CLOSEOUT_DONE pins that it no longer counts.)
const BOARD_CLOSEOUT_DONE = toolUse('Bash', { command: 'node scripts/linear-brain.js update BRO-4274 --state="Done" --comment="Shipped and verified."' });
const BOARD_CLOSEOUT_PAUSED = toolUse('Bash', { command: 'node scripts/linear-session.js report --issue=BRO-4274 --status paused --summary "Blocked on owner decision."' });
const BOARD_UPDATE_IN_PROGRESS = toolUse('Bash', { command: 'node scripts/linear-brain.js update BRO-4274 --state="In Progress" --comment="Still working on this."' });
const NOTION_CLOSEOUT_DONE = toolUse('Bash', { command: 'node scripts/notion-brain.js update 3c5637c5-416f-81a0-bd7e-c388c5673dc5 --status="Done" --outcome="Shipped and verified."' });

// ─────────────────────────── wrap-up-close-out gate ────────────────────────
// Root cause (v1): a real session's final message read "SAFE TO ARCHIVE — fix
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
// mandates: this session's Linear card actually closed out (Done, or parked). Cases
// below cover both the original "no close-out at all" failure mode AND the
// new failure modes a plan-review pass surfaced: a Skill call with no real
// close-out, a real board call that never actually closes the card
// (still "In Progress"), and — the concrete exploit a SECOND /second-opinion
// review found in the first regex-based draft of this redesign — quoted
// example text inside --comment/--summary that LOOKS like a close-out to a
// naive whole-string regex search but isn't the real --state flag.

test('substantial work + SAFE TO ARCHIVE + no board close-out at all → BLOCKED (NOWRAPUP)', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-block-none');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const r = runHook(transcript, 'Pushed and verified live.\n\nSAFE TO ARCHIVE — fix confirmed live in production, nothing outstanding.');
  assertBlocked(r, 'claims SAFE TO ARCHIVE after real work but never closed out the Linear card');
  assert.match(r.stderr, /wrap-up/i, `expected a wrap-up reminder, got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CRITICAL (owner-rejected v1 behavior): Skill(wrap-up) called but NO real board close-out → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-block-token-gesture');
  // This is exactly the case the owner called out: invoking the skill alone
  // (a tool-name gesture) must NOT satisfy the gate — only v1 would have
  // passed this. Proves the redesign actually changed behavior, not just
  // its rationale comment.
  const transcript = writeTranscript(dir, [GIT_PUSH, WRAP_UP]);
  const r = runHook(transcript, 'Pushed, then ran /wrap-up.\n\nSAFE TO ARCHIVE — pushed, wrap-up complete, nothing pending.');
  assertBlocked(r, 'invoking the wrap-up skill without a real board close-out must no longer satisfy the gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Linear card touched but left "In Progress" (not Done/Backlog) → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-block-still-in-progress');
  const transcript = writeTranscript(dir, [GIT_PUSH, BOARD_UPDATE_IN_PROGRESS]);
  const r = runHook(transcript, 'Pushed and updated the card.\n\nSAFE TO ARCHIVE — pushed, card updated.');
  assertBlocked(r, 'a linear-brain.js update that never actually closes the card (still In Progress) must not satisfy the gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('EXPLOIT REGRESSION (2nd /second-opinion finding): quoted example "--state Done" inside --comment, real state still In Progress → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-block-exploit-quoted-example');
  // The real --state is "In Progress"; the --comment value merely QUOTES
  // the example command `linear-brain.js update <id> --state Done` as
  // documentation text (this repo's own docs do exactly this). A naive
  // regex search across the whole raw command string would have matched
  // "--state Done" inside that quoted text and wrongly passed. The
  // tokenized (shlex) check must only look at the REAL --state flag's
  // value, so this must still block.
  const exploitCmd = toolUse('Bash', {
    command: 'node scripts/linear-brain.js update BRO-4274 --state="In Progress" --comment="documented as e.g. linear-brain.js update <id> --state Done for closeout"',
  });
  const transcript = writeTranscript(dir, [GIT_PUSH, exploitCmd]);
  const r = runHook(transcript, 'Pushed and updated the card with docs about the gate.\n\nSAFE TO ARCHIVE — pushed, card updated.');
  assertBlocked(r, 'quoted example text inside --comment must not satisfy the gate when the real --state is not a close-out');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('substantial work + real Linear close-out (Done) AFTER the work + SAFE TO ARCHIVE → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-after');
  const transcript = writeTranscript(dir, [GIT_PUSH, BOARD_CLOSEOUT_DONE]);
  const r = runHook(transcript, 'Pushed, then closed out the Linear card.\n\nSAFE TO ARCHIVE — pushed, Linear card set to Done, nothing pending.');
  assertAllowed(r, 'a genuine Linear close-out after the work it is meant to cover must satisfy the gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('substantial work + real Linear close-out (linear-session report paused, space-separated flag form) + SAFE TO ARCHIVE → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-paused-space-form');
  const transcript = writeTranscript(dir, [GIT_PUSH, BOARD_CLOSEOUT_PAUSED]);
  const r = runHook(transcript, 'Pushed, paused the card pending an owner decision.\n\nSAFE TO ARCHIVE — pushed, nothing hanging, card paused with context.');
  assertAllowed(r, 'Paused is a legitimate close-out status too, and the space-separated --status paused form must parse');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('real-world shape: heredoc-wrapped --comment with apostrophed prose around a real --state=Done → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-heredoc-real');
  // Matches this repo's actual convention (CLAUDE.md's own heredoc
  // commit-message rule, applied the same way to linear-brain.js --comment
  // values) — multi-line prose via `$(cat <<'EOF' ... EOF)`, including
  // apostrophes that would break a naive shlex.split without heredoc
  // stripping first.
  const heredocCmd = toolUse('Bash', {
    command: [
      'node scripts/linear-brain.js update BRO-4274 --state="Done" --comment="$(cat <<\'EOF\'',
      "Shipped the fix. It's done, no loose ends, didn't need anything paused.",
      'EOF',
      ')"',
    ].join('\n'),
  });
  const transcript = writeTranscript(dir, [GIT_PUSH, heredocCmd]);
  const r = runHook(transcript, 'Pushed and wrote up the full outcome.\n\nSAFE TO ARCHIVE — pushed, card closed out.');
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

test('composition seam: single-line --comment mentioning heredoc syntax as PROSE (no real heredoc) + real Done → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-seam-prose-mention');
  const mentionCmd = toolUse('Bash', {
    command: `node scripts/linear-brain.js update BRO-4274 --state=Done --comment="uses a heredoc like <<'EOF' internally"`,
  });
  const transcript = writeTranscript(dir, [GIT_PUSH, mentionCmd]);
  const r = runHook(transcript, 'Pushed and documented it.\n\nSAFE TO ARCHIVE — pushed, card closed out.');
  assertAllowed(r, 'a short --comment that merely MENTIONS heredoc syntax as text, with no actual multi-line heredoc structure, must still parse to a real Done');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('composition seam: real heredoc body whose OWN prose mentions "<<TAG" on its own line + real Done → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-seam-nested-mention');
  // The exact shape both reviewers flagged as a hypothetical risk: inside a
  // REAL heredoc body, a line that itself looks like it could open another
  // heredoc. _strip_heredocs() only scans for new opens on lines it APPENDS
  // to output (lines outside any currently-open heredoc) — lines being
  // skipped as body content are never re-scanned — so this must not
  // truncate the strip early or corrupt the surrounding --state flag.
  const nestedCmd = toolUse('Bash', {
    command: [
      'node scripts/linear-brain.js update BRO-4274 --state="Done" --comment="$(cat <<\'EOF\'',
      'Explaining the fix: heredocs open with <<TAG',
      'EOF',
      ')"',
    ].join('\n'),
  });
  const transcript = writeTranscript(dir, [GIT_PUSH, nestedCmd]);
  const r = runHook(transcript, 'Pushed and documented it.\n\nSAFE TO ARCHIVE — pushed, card closed out.');
  assertAllowed(r, 'a heredoc body that describes heredoc syntax on its own line must not confuse the stripper into corrupting the real --state flag');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('composition seam: unterminated/malformed heredoc → gate fails toward BLOCKED, hook does not crash', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-block-seam-unterminated');
  // A truncated/malformed command (no closing heredoc tag) must not throw an
  // unhandled exception that takes down the whole Stop hook script — it
  // should fail toward "no close-out detected" (block) via the inner
  // try/except in _board_closeout_status, same as any other unparseable
  // command. Exit code 2 (not e.g. a spawn error / non-2/0 code) is itself
  // proof the process didn't crash.
  const malformedCmd = toolUse('Bash', {
    command: "node scripts/linear-brain.js update BRO-1 --state=\"Done\" --comment=\"$(cat <<'EOF'\nsome unterminated body with no closing tag",
  });
  const transcript = writeTranscript(dir, [GIT_PUSH, malformedCmd]);
  const r = runHook(transcript, 'Pushed.\n\nSAFE TO ARCHIVE — pushed.');
  assertBlocked(r, 'a malformed/unterminated heredoc must fail toward blocking, not crash the hook or silently pass');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CRITICAL gaming case (found by /second-opinion review): close-out happened, then MORE work happened after it, then SAFE TO ARCHIVE → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-block-stale');
  // The close-out happened early, but a second push happened afterward that
  // it never covered — an "anywhere in session" check would wrongly pass
  // this.
  const transcript = writeTranscript(dir, [GIT_PUSH, BOARD_CLOSEOUT_DONE, toolUse('Bash', { command: 'git push -u origin some-branch --force-with-lease' })]);
  const r = runHook(transcript, 'Pushed, closed out, then had to push a follow-up fix.\n\nSAFE TO ARCHIVE — follow-up pushed, nothing pending.');
  assertBlocked(r, 'a stale close-out that happened BEFORE the last substantial work must not satisfy the gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRO-4274: a notion-brain.js update --status Done alone is NOT a close-out (Notion retired) → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-block-notion-only');
  const transcript = writeTranscript(dir, [GIT_PUSH, NOTION_CLOSEOUT_DONE]);
  const r = runHook(transcript, 'Pushed, closed the Notion card.\n\nSAFE TO ARCHIVE — pushed, card closed.');
  assertBlocked(r, 'a Notion update leaves the Linear card of record open, so it must not satisfy NOWRAPUP');
  assert.match(r.stderr, /linear-brain\.js update/, `expected the Linear close-out command in the block message, got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRO-4274: Notion update AND a Linear close-out after the work → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-notion-and-linear');
  const transcript = writeTranscript(dir, [GIT_PUSH, NOTION_CLOSEOUT_DONE, BOARD_CLOSEOUT_DONE]);
  const r = runHook(transcript, 'Pushed, closed out the card.\n\nSAFE TO ARCHIVE — pushed, card closed.');
  assertAllowed(r, 'a real Linear close-out satisfies the gate regardless of a stray Notion call');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRO-4274: NO-CARD session (no card by design) + SAFE TO ARCHIVE → not NOWRAPUP-blocked', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-no-card');
  const transcript = writeTranscript(dir, [GIT_PUSH], { card: false });
  const r = runHook(transcript, 'Pushed a one-line data fix.\n\nNO-CARD: owner-requested one-off data typo fix\n\nSAFE TO ARCHIVE — pushed.');
  assertAllowed(r, 'NOCARD accepted NO-CARD, so NOWRAPUP must not demand closing a card that does not exist');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRO-4274: session that FILED a card cannot use NO-CARD to skip closing it → BLOCKED (NOWRAPUP)', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-block-no-card-abuse');
  const transcript = writeTranscript(dir, [GIT_PUSH]); // card: true — a Linear card was filed
  const r = runHook(transcript, 'Pushed.\n\nNO-CARD: trying to skip the close-out step\n\nSAFE TO ARCHIVE — pushed.');
  assertBlocked(r, 'NO-CARD only excuses a session with no card; a filed card still has to be closed out');
  assert.match(r.stderr, /linear-brain\.js update/, `expected NOWRAPUP's close-out instruction, got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wrap-up gate: KEEP OPEN + no close-out → ALLOWED (session has not claimed full completion)', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-notsafe');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const r = runHook(transcript, 'Pushed. Deploy still running.\n\nKEEP OPEN — deploy still running, will verify next check-in.');
  assertAllowed(r, 'KEEP OPEN does not claim completion, so a close-out is not required yet');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CRITICAL false-positive guard: no substantial work at all → ALLOWED regardless of close-out', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-no-work');
  const transcript = writeTranscript(dir, []);
  const r = runHook(transcript, 'Sure, happy to answer that question.');
  assertAllowed(r, 'a plain conversational reply must never require a board close-out');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wrap-up gate bypass: NO-VERIFY: allows a missing close-out', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-noverify');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const r = runHook(transcript, 'Pushed a trivial fix. NO-VERIFY: docs-only, close-out ceremony not needed.\n\nSAFE TO ARCHIVE — pushed.');
  assertAllowed(r, 'NO-VERIFY bypass must still work for the wrap-up gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wrap-up gate kill switch: WRAPUP_GATE_DISABLE=1 allows a missing close-out', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-allow-killswitch');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const r = runHook(transcript, 'Pushed.\n\nSAFE TO ARCHIVE — pushed.', { WRAPUP_GATE_DISABLE: '1' });
  assertAllowed(r, 'kill switch must fully disable the wrap-up gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wrap-up gate: independent of SESSION_STATUS_GATE_DISABLE (no coupling — /second-opinion review finding)', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-block-independent-killswitch');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  // Disabling the STATUS-LINE gate must not also silently disable the
  // wrap-up gate — they are deliberately separate top-level blocks.
  const r = runHook(transcript, 'Pushed.\n\nSAFE TO ARCHIVE — pushed, nothing pending.', { SESSION_STATUS_GATE_DISABLE: '1' });
  assertBlocked(r, 'disabling the status-line gate must not disable the independent wrap-up gate');
  assert.match(r.stderr, /wrap-up/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('regression: a fully clean session (edit + verify + push + Linear close-out + valid status, no PR) → ALLOWED end to end', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-regress-clean');
  const transcript = writeTranscript(dir, [
    QUALIFYING_EDIT,
    toolUse('Bash', { command: 'npx tsc --noEmit src/lib/scoring.ts' }),
    SHIP_CHECK,
    WHAT_ELSE,
    WRAP_UP,
    GIT_PUSH,
    BOARD_CLOSEOUT_DONE,
  ]);
  const r = runHook(transcript, 'Fixed, verified, pushed, closed out the card.\n\nSAFE TO ARCHIVE — verified with tsc, pushed, card set to Done.');
  assertAllowed(r, 'a fully clean, fully reported session must pass all gates including the redesigned wrap-up one');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────── status-line gate ────────────────────────────

test('substantial work (code edit) + no closing status line → BLOCKED (NOSTATUSLINE)', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-block-edit');
  const transcript = writeTranscript(dir, [QUALIFYING_EDIT, toolUse('Bash', { command: 'npx tsc --noEmit src/lib/scoring.ts' })]);
  const r = runHook(transcript, 'Fixed the rounding bug and verified with tsc.');
  assertBlocked(r, 'edit+verify but no status line');
  assert.match(r.stderr, /SAFE TO ARCHIVE/, `expected a SAFE TO ARCHIVE reminder, got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('substantial work (git push) + no closing status line → BLOCKED (NOSTATUSLINE)', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-block-push');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const r = runHook(transcript, 'Pushed the branch. Let me know if you want anything else!');
  assertBlocked(r, 'git push but no status line');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('substantial work (git push) + valid SAFE TO ARCHIVE line → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-allow-safe');
  const transcript = writeTranscript(dir, [GIT_PUSH, BOARD_CLOSEOUT_DONE]);
  const r = runHook(transcript, 'Pushed and verified CI green.\n\nSAFE TO ARCHIVE — branch pushed, CI green, nothing pending.');
  assertAllowed(r, 'valid SAFE TO ARCHIVE line');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('substantial work (git push) + valid KEEP OPEN line → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-allow-notsafe');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const r = runHook(transcript, 'Pushed. Deploy still running.\n\nKEEP OPEN — deploy still running, will verify next check-in.');
  assertAllowed(r, 'valid KEEP OPEN line');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('regression (ship-check adversarial review 2026-08-23): canonical wrap-up.md SESSION STATUS block, WITH its trailing divider rule after SAFE TO ARCHIVE, must pass', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-allow-canonical-divider');
  const transcript = writeTranscript(dir, [GIT_PUSH, BOARD_CLOSEOUT_DONE]);
  // Exact shape wrap-up.md specifies: a divider line, DONE/CONTINUING/NEEDS YOU
  // rows, the SAFE TO ARCHIVE line, then ANOTHER divider line below it. Before the
  // fix, checking the literal last non-empty line saw the divider, not the
  // status line, and wrongly BLOCKED every correctly-formatted wrap-up.
  const msg = [
    '──────────────────────────────────────────',
    'DONE        Pushed and verified.',
    'CONTINUING  none',
    'NEEDS YOU   nothing',
    'SAFE TO ARCHIVE — pushed, verified, nothing pending.',
    '──────────────────────────────────────────',
  ].join('\n');
  const r = runHook(transcript, msg);
  assertAllowed(r, 'canonical wrap-up.md block with trailing divider must not be misread as missing a status line');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('regression: trailing divider after KEEP OPEN also passes', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-allow-canonical-divider-notsafe');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const msg = [
    '──────────────────────────────────────────',
    'KEEP OPEN — deploy still running.',
    '──────────────────────────────────────────',
  ].join('\n');
  const r = runHook(transcript, msg);
  assertAllowed(r, 'canonical KEEP OPEN block with trailing divider must pass');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status-line gate still blocks when the real last line is unrelated trailing prose (no divider)', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-block-trailing-prose');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const msg = [
    'SAFE TO ARCHIVE — pushed and verified.',
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
  const transcript = writeTranscript(dir, [GIT_PUSH, BOARD_CLOSEOUT_DONE]);
  const msg = [
    "There's no DECISION NEEDED here — I already decided retries stay at 3 and pushed it.",
    '',
    'SAFE TO ARCHIVE — decided, pushed, verified.',
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
    'SAFE TO ARCHIVE — PR open, nothing else pending.',
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
  assertAllowed(r, 'a research-only turn ending in a question must not require SAFE TO ARCHIVE');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DECISION NEEDED present but message falsely claims SAFE TO ARCHIVE → BLOCKED (FALSESAFE)', skipNoRepoHook, () => {
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
    'SAFE TO ARCHIVE — pushed and ready.',
  ].join('\n');
  const r = runHook(transcript, msg);
  assertBlocked(r, 'DECISION NEEDED contradicts SAFE TO ARCHIVE claim');
  assert.match(r.stderr, /DECISION NEEDED/, `expected the contradiction message, got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('DECISION NEEDED present with correct ACTION NEEDED FROM YOU line → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-allow-decision-notsafe');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const msg = [
    'Pushed the fix.',
    '',
    'DECISION NEEDED: should the retry limit be 3 or 5?',
    'My recommendation: 3',
    '',
    'ACTION NEEDED FROM YOU — answer the DECISION NEEDED above.',
  ].join('\n');
  const r = runHook(transcript, msg);
  assertAllowed(r, 'DECISION NEEDED correctly paired with ACTION NEEDED FROM YOU');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status-line gate: fenced code block containing SAFE TO ARCHIVE text is stripped, real trailing line still required', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-block-fence-gaming');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const msg = [
    'Pushed. Example of the format for next time:',
    '```',
    'SAFE TO ARCHIVE — example only, not a real status line',
    '```',
    'That\'s all for now.',
  ].join('\n');
  const r = runHook(transcript, msg);
  assertBlocked(r, 'a SAFE TO ARCHIVE string inside a code fence must not satisfy the gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status-line gate: real status line survives when an UNRELATED fenced block precedes it', skipNoRepoHook, () => {
  const dir = makeTmpDir('status-allow-fence-then-real');
  const transcript = writeTranscript(dir, [GIT_PUSH, BOARD_CLOSEOUT_DONE]);
  const msg = [
    'Pushed. Here is the diff for reference:',
    '```diff',
    '+ SAFE TO ARCHIVE is not a real line here, just diff context',
    '```',
    '',
    'SAFE TO ARCHIVE — pushed, verified, nothing pending.',
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
  const r = runHook(transcript, "Opened PR #42.\n\nSAFE TO ARCHIVE — PR open, nothing else pending.");
  assertBlocked(r, 'PR opened, never merged, no blocker stated');
  assert.match(r.stderr, /land it yourself/i, `expected the land-it-yourself reminder, got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PR opened via MCP AND merged same session → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('pr-allow-merged');
  const transcript = writeTranscript(dir, [CREATE_PR, MERGE_PR, BOARD_CLOSEOUT_DONE]);
  const r = runHook(transcript, "Opened PR #42, CI passed, merged it.\n\nSAFE TO ARCHIVE — merged and live.");
  assertAllowed(r, 'PR opened and merged same session');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PR opened, not merged, but a real blocker (CI red) is stated → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('pr-allow-blocked');
  const transcript = writeTranscript(dir, [CREATE_PR]);
  const r = runHook(transcript, "Opened PR #42 but CI is red on the typecheck job — investigating.\n\nKEEP OPEN — CI red on PR #42, fixing next.");
  assertAllowed(r, 'a genuinely stated CI-red blocker must pass');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CRITICAL false-positive guard: no PR tool calls at all → ALLOWED regardless of message content', skipNoRepoHook, () => {
  const dir = makeTmpDir('pr-allow-no-pr');
  const transcript = writeTranscript(dir, [GIT_PUSH, BOARD_CLOSEOUT_DONE]);
  const r = runHook(transcript, "Pushed directly, no PR needed for this repo's workflow.\n\nSAFE TO ARCHIVE — pushed to branch, no PR opened this session.");
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
  const transcript = writeTranscript(dir, [CREATE_PR, BOARD_CLOSEOUT_DONE]);
  // Valid status line included deliberately: this case isolates the PR gate's
  // OWN kill switch. Disabling only PR_FOLLOWTHROUGH_GATE_DISABLE must not
  // also bypass the separate, still-active session-status gate — a message
  // with no status line at all would conflate the two gates' kill switches.
  const r = runHook(transcript, 'Opened PR #42.\n\nSAFE TO ARCHIVE — PR open, kill switch test.', { PR_FOLLOWTHROUGH_GATE_DISABLE: '1' });
  assertAllowed(r, 'kill switch must fully disable the PR gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────── owner never merges: OWNERMERGE / land/** (2026-09-27) ────────────

const LAND_PUSH = toolUse('Bash', { command: 'git push origin HEAD:refs/heads/land/fix-x' });
const LAND_CREATE_BRANCH = toolUse('mcp__github__create_branch', { owner: 'thomaspryor', repo: 'Broadwayscore', branch: 'land/fix-x' });
const LAND_RUN_CHECK = toolUse('mcp__github__actions_list', { method: 'list_workflow_runs', owner: 'thomaspryor', repo: 'Broadwayscore', resource_id: 'land.yml' });
const LINEAR_CLOSEOUT_DONE = toolUse('Bash', { command: 'node scripts/linear-brain.js update BRO-4187 --state Done --comment "landed"' });

test('OWNERMERGE: "waiting on your merge" blocks even with KEEP OPEN', skipNoRepoHook, () => {
  const dir = makeTmpDir('ownermerge-block');
  const transcript = writeTranscript(dir, [CREATE_PR]);
  const r = runHook(transcript, "PR #42 is green.\n\nKEEP OPEN — PR #42 green, waiting on your merge.");
  assertBlocked(r, 'asking the owner to merge must block');
  assert.match(r.stderr, /owner never merges/i, `got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('OWNERMERGE false-positive guard: describing or quoting the rule is not a merge ask', skipNoRepoHook, () => {
  const dir = makeTmpDir('ownermerge-describe');
  const transcript = writeTranscript(dir, [CREATE_PR, toolUse('Bash', { command: 'git push origin HEAD:refs/heads/land/x' }), toolUse('mcp__github__actions_get', { method: 'get_workflow_run' }), toolUse('Bash', { command: 'node scripts/linear-brain.js update BRO-1 --state Done' })]);
  const r = runHook(transcript, 'Landed. Sessions never ask the owner to merge, and the Stop hook now blocks "waiting on your merge" and `ready to merge`.\n\nSAFE TO ARCHIVE — landed and verified.');
  assertAllowed(r, 'a description or quotation of the rule must not trip OWNERMERGE');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('OWNERMERGE false-positive guard: a real owner decision ("waiting on your decision") is allowed', skipNoRepoHook, () => {
  const dir = makeTmpDir('ownermerge-decision');
  const transcript = writeTranscript(dir, [CREATE_PR]);
  const r = runHook(transcript, "DECISION NEEDED: pricing tier for /biz.\n\nACTION NEEDED FROM YOU — waiting on your decision on pricing.");
  assertAllowed(r, 'owner decisions are not merge asks');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('OWNERMERGE false-positive guard: "merge conflict" is a stated blocker, not a merge ask', skipNoRepoHook, () => {
  const dir = makeTmpDir('ownermerge-conflict');
  const transcript = writeTranscript(dir, [CREATE_PR]);
  const r = runHook(transcript, "Resolving it now.\n\nKEEP OPEN — merge conflict on PR #42.");
  assertAllowed(r, 'merge conflict must stay a legitimate blocker');
  fs.rmSync(dir, { recursive: true, force: true });
});

// BRO-5915: github-main-guard.sh now refuses PR creation, so a refused call
// must not count as an opened PR; and a Bash `gh pr create` that printed a PR
// URL must count (it never did, so OWNERMERGE/PRUNMERGED could not fire).
const REFUSED_CREATE_PR = { ...toolUse('mcp__github__create_pull_request', { owner: 'thomaspryor', repo: 'Broadwayscore', title: 'x', head: 'a', base: 'main' }, 'PreToolUse:mcp__github__create_pull_request hook error: 🛑 BLOCKED: sessions never open Broadwayscore PRs (BRO-5915)'), _isError: true };
const GH_PR_CREATE = toolUse('Bash', { command: 'gh pr create --draft --fill' }, 'https://github.com/thomaspryor/Broadwayscore/pull/42');

test('BRO-5915: a REFUSED create_pull_request is not an opened PR → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('pr-refused-create');
  const msg = "Pushed the branch.\n\nSAFE TO ARCHIVE — pushed to branch, no PR opened this session.";
  assertAllowed(runHook(writeTranscript(dir, [REFUSED_CREATE_PR, GIT_PUSH, BOARD_CLOSEOUT_DONE]), msg), 'a hook-refused PR call opened nothing');
  // Control: the identical transcript with a successful create blocks.
  assertBlocked(runHook(writeTranscript(dir, [CREATE_PR, GIT_PUSH, BOARD_CLOSEOUT_DONE]), msg), 'control: a real open PR still blocks');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRO-5915: Bash `gh pr create` that printed a PR URL counts as an opened PR (PRUNMERGED)', skipNoRepoHook, () => {
  const dir = makeTmpDir('pr-gh-create');
  const r = runHook(writeTranscript(dir, [GH_PR_CREATE, BOARD_CLOSEOUT_DONE]), "Opened PR #42.\n\nSAFE TO ARCHIVE — PR open, nothing else pending.");
  assertBlocked(r, 'a Bash-opened PR left unmerged must block');
  assert.match(r.stderr, /land it yourself/i, `got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRO-5915: reading PRs (gh api GET …/pulls, …/pulls/N/comments) is not opening one → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('pr-read-only');
  const listing = '[{"number":42,"html_url":"https://github.com/thomaspryor/Broadwayscore/pull/42","state":"open"}]';
  const reads = [
    toolUse('Bash', { command: "gh api 'repos/thomaspryor/Broadwayscore/pulls?state=open'" }, listing),
    toolUse('Bash', { command: 'gh api repos/thomaspryor/Broadwayscore/pulls/42' }, listing),
    toolUse('Bash', { command: 'gh api repos/thomaspryor/Broadwayscore/pulls/42/comments -f body=x' }, listing),
  ];
  const r = runHook(writeTranscript(dir, [...reads, GIT_PUSH, BOARD_CLOSEOUT_DONE]), "Checked the open PRs.\n\nSAFE TO ARCHIVE — pushed to branch, no PR opened this session.");
  assertAllowed(r, 'PR reads print PR URLs but open nothing');
  // Control: a REST create counts.
  const create = toolUse('Bash', { command: 'gh api -X POST repos/thomaspryor/Broadwayscore/pulls -f head=x -f base=main' }, listing);
  assertBlocked(runHook(writeTranscript(dir, [create, GIT_PUSH, BOARD_CLOSEOUT_DONE]), "Opened a PR.\n\nSAFE TO ARCHIVE — PR open."), 'control: a REST create still counts');
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const ask of ['Please merge PR #42 when you get a chance.', "You'll need to merge both PRs.", 'You need to merge #42 and #43.', 'Merge #1170 first, then data#3.', 'All green. Merge the draft PRs when ready.']) {
  test(`BRO-5915 OWNERMERGE imperative ask blocks: ${ask}`, skipNoRepoHook, () => {
    const dir = makeTmpDir('ownermerge-imperative');
    const r = runHook(writeTranscript(dir, [GH_PR_CREATE]), `${ask}\n\nKEEP OPEN — CI still running on PR #42.`);
    assertBlocked(r, 'an imperative merge ask must block');
    assert.match(r.stderr, /never merges/i, `OWNERMERGE must be the gate that fired, got: ${r.stderr.slice(0, 300)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('OWNERMERGE false-positive guard: own-action and rule-description "merge" wording is allowed', skipNoRepoHook, () => {
  for (const msg of ["Merge main into the branch first, then I pushed land/x.", "I merged #42 myself via land. The owner never needs to merge #43.", "Don't merge #42, it already landed."]) {
    assertAllowed(runOnPr('ownermerge-own', `${msg}\n\nKEEP OPEN — CI still running on PR #42.`), msg);
  }
});

test('BRO-5915 OWNERMERGE false-positive guard: "need to merge conflicts" is not a merge ask', skipNoRepoHook, () => {
  const r = runOnPr('ownermerge-conflicts', "Rebased; you'll need to merge conflicts only if main moves again.\n\nKEEP OPEN — CI still running on PR #42.");
  assertAllowed(r, 'merging conflicts is not asking the owner to merge a PR');
});

test('land/** push + checked Land run + Linear close-out → SAFE TO ARCHIVE allowed (PR gate satisfied)', skipNoRepoHook, () => {
  const dir = makeTmpDir('land-allow');
  const transcript = writeTranscript(dir, [CREATE_PR, LAND_PUSH, LAND_RUN_CHECK, LINEAR_CLOSEOUT_DONE]);
  const r = runHook(transcript, "Landed via land.yml; main fast-forwarded.\n\nSAFE TO ARCHIVE — landed and verified.");
  assertAllowed(r, 'a landed branch satisfies the PR gate, and Linear close-out satisfies wrap-up');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MCP create_branch land/** counts as landing follow-through', skipNoRepoHook, () => {
  const dir = makeTmpDir('land-mcp');
  const transcript = writeTranscript(dir, [CREATE_PR, LAND_CREATE_BRANCH, LAND_RUN_CHECK, LINEAR_CLOSEOUT_DONE]);
  const r = runHook(transcript, "Landed.\n\nSAFE TO ARCHIVE — landed via MCP land branch.");
  assertAllowed(r, 'MCP land/** branch is the cloud fallback');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('LANDUNCHECKED: land/** push then SAFE TO ARCHIVE without checking the run → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('land-unchecked');
  const transcript = writeTranscript(dir, [CREATE_PR, LAND_PUSH, LINEAR_CLOSEOUT_DONE]);
  const r = runHook(transcript, "Pushed to land.\n\nSAFE TO ARCHIVE — pushed.");
  assertBlocked(r, 'push to land/** is not proof it landed');
  assert.match(r.stderr, /Land run/i, `got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('land/** match is anchored: a branch named foo-land/x is not a landing', skipNoRepoHook, () => {
  const dir = makeTmpDir('land-anchor');
  const transcript = writeTranscript(dir, [CREATE_PR, toolUse('Bash', { command: 'git push origin HEAD:foo-land/x' }), BOARD_CLOSEOUT_DONE]);
  const r = runHook(transcript, "Pushed.\n\nSAFE TO ARCHIVE — pushed.");
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
  const transcript = writeTranscript(dir, [QUALIFYING_EDIT, SHIP_CHECK, WHAT_ELSE, BOARD_CLOSEOUT_DONE]);
  const r = runHook(transcript, 'SAFE TO ARCHIVE — done.'); // valid status line + Linear close-out done, so the NEW gates pass clean
  assertBlocked(r, 'an unverified code edit must still block on its own pre-existing gate');
  assert.match(r.stderr, /unverified edit/i, `expected the pre-existing UNVERIFIED message, got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('regression: a fully clean session, standalone check (edit + verify + push + wrap-up + valid status, no PR) → ALLOWED end to end', skipNoRepoHook, () => {
  const dir = makeTmpDir('regress-clean');
  const transcript = writeTranscript(dir, [
    QUALIFYING_EDIT,
    toolUse('Bash', { command: 'npx tsc --noEmit src/lib/scoring.ts' }),
    SHIP_CHECK,
    WHAT_ELSE,
    WRAP_UP,
    GIT_PUSH,
    BOARD_CLOSEOUT_DONE,
  ]);
  const r = runHook(transcript, 'Fixed, verified, pushed.\n\nSAFE TO ARCHIVE — verified with tsc, pushed to branch.');
  assertAllowed(r, 'a fully clean, fully reported session must pass all gates');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────── review-parking + bare KEEP OPEN (2026-09-28) ────────────
// Session 01Fn6CXk held PR #947 for ~11h ending every turn on "NOT SAFE TO
// EXIT — PR still open and unreviewed". OWNERMERGE only knew merge-asks, and
// PRUNMERGED accepted the bare KEEP OPEN line the status gate requires
// on every such turn — so nothing ever fired.

function runOnPr(label, msg, env = {}) {
  const dir = makeTmpDir(label);
  const transcript = writeTranscript(dir, [CREATE_PR]);
  const r = runHook(transcript, msg, env);
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

test('INCIDENT REPLAY: "KEEP OPEN — PR still open and unreviewed" → BLOCKED', skipNoRepoHook, () => {
  const r = runOnPr('review-incident', 'Still open, still draft, no new activity.\n\nKEEP OPEN — PR #947 still open and unreviewed; next silent check-in at 00:13 UTC.');
  assertBlocked(r, 'parking a PR as "unreviewed" is a review ask');
  assert.match(r.stderr, /never merges or reviews/i, `got: ${r.stderr.slice(0, 300)}`);
});

test('review ask: "ready for your review" → BLOCKED', skipNoRepoHook, () => {
  const r = runOnPr('review-ready-for-your', 'NEEDS YOU — PR #947 is ready for your review.\n\nKEEP OPEN — CI still running on PR #947.');
  assertBlocked(r, 'asking the owner to review must block even with a real blocker alongside');
});

test('review ask: "waiting on reviewers" → BLOCKED', skipNoRepoHook, () => {
  const r = runOnPr('review-waiting-reviewers', 'Everything is green.\n\nKEEP OPEN — waiting on reviewers for PR #42.');
  assertBlocked(r, '"waiting on reviewers" is a review ask');
  assert.match(r.stderr, /never merges or reviews/i, `OWNERMERGE must be the gate that fired, got: ${r.stderr.slice(0, 300)}`);
});

test('bare KEEP OPEN is no longer a stated blocker → BLOCKED (PRUNMERGED)', skipNoRepoHook, () => {
  const r = runOnPr('bare-notsafe', 'Opened PR #42.\n\nKEEP OPEN — PR #42 open.');
  assertBlocked(r, 'the status line alone must not satisfy the PR gate');
  assert.match(r.stderr, /land it yourself/i, `got: ${r.stderr.slice(0, 300)}`);
});

test('"draft pending" is no longer a stated blocker → BLOCKED', skipNoRepoHook, () => {
  const r = runOnPr('draft-pending', 'Opened PR #42 as a draft pending follow-up.\n\nKEEP OPEN — draft pending.');
  assertBlocked(r, 'a draft is not a blocker');
  assert.match(r.stderr, /land it yourself/i, `PRUNMERGED must be the gate that fired, got: ${r.stderr.slice(0, 300)}`);
});

test('CI still running is a legitimate blocker → ALLOWED', skipNoRepoHook, () => {
  const r = runOnPr('ci-running', 'Opened PR #42; test.yml started 1 min ago.\n\nKEEP OPEN — CI still running on PR #42, check-in scheduled.');
  assertAllowed(r, 'waiting on a running CI run is legitimate');
});

test('explicit PR-BLOCKER line with a specific reason → ALLOWED', skipNoRepoHook, () => {
  const r = runOnPr('pr-blocker', 'Land refused it.\nPR-BLOCKER: land.yml refused: tsc error in src/lib/scoring.ts:42\n\nKEEP OPEN — fixing the tsc error next.');
  assertAllowed(r, 'a specific PR-BLOCKER reason must pass');
});

test('PR-BLOCKER with a throwaway reason (<10 chars) → BLOCKED', skipNoRepoHook, () => {
  const r = runOnPr('pr-blocker-short', 'PR-BLOCKER: wip\n\nKEEP OPEN — later.');
  assertBlocked(r, 'a token with no real reason must not satisfy the gate');
  assert.match(r.stderr, /land it yourself/i, `got: ${r.stderr.slice(0, 300)}`);
});

test('describing the rule in backticks is not a review ask → ALLOWED', skipNoRepoHook, () => {
  const r = runOnPr('review-quoted', 'The gate now blocks `waiting on review` and `unreviewed`.\n\nKEEP OPEN — CI still running on PR #42.');
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
const NOT_SAFE = 'Pushed.\n\nKEEP OPEN — deploy still running.';

test('NOCARD: real work (push) with no Linear card → BLOCKED', skipNoRepoHook, () => {
  const r = runCard('nocard-block', [GIT_PUSH], NOT_SAFE);
  assertBlocked(r, 'work without a card must block');
  assert.match(r.stderr, /Linear card/i, `got: ${r.stderr.slice(0, 300)}`);
  assert.doesNotMatch(r.stderr, /notion-brain\.js create/, 'must not send sessions to the retired Notion CLI');
});

test('NOCARD: a code edit alone also needs a card → BLOCKED', skipNoRepoHook, () => {
  const r = runCard('nocard-edit', [QUALIFYING_EDIT, toolUse('Bash', { command: 'npx tsc --noEmit' })], 'Edited and type-checked.\n\nKEEP OPEN — not pushed yet.');
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

test('NOCARD: a create refused as a repeat of an open card (BRO-5488, exit 8) → BLOCKED', skipNoRepoHook, () => {
  const refused = toolUse('Bash', { command: 'node scripts/linear-brain.js create "Fix the thing again" --dispatch --notes "y"' }, 'ALREADY-OPEN: already open: BRO-4871 Fix the thing [Todo] (title match 0.82). Work on that card (node scripts/linear-session.js claim --issue=BRO-4871), or if this is different work re-run with --new-anyway "<why>".\n__BOARD_CARD_MATCH__=BRO-4871');
  const r = runCard('nocard-create-refused', [refused, GIT_PUSH], NOT_SAFE);
  assertBlocked(r, 'a refused create names a card but made none; the session must claim it');
});

test('NOCARD: a refused --dispatch then a successful --park in one command → ALLOWED', skipNoRepoHook, () => {
  const both = toolUse('Bash', { command: 'node scripts/linear-brain.js create "x" --dispatch --notes "y" || node scripts/linear-brain.js create "x" --park "later" --notes "y"' }, 'ALREADY-OPEN: already open: BRO-4871 x [Todo] (title match 0.82).\n__BOARD_CARD_MATCH__=BRO-4871\nPARKED: BRO-9010 ("x")\n__BOARD_CARD_ID__=BRO-9010');
  const r = runCard('nocard-refused-then-parked', [both, GIT_PUSH], NOT_SAFE);
  assertAllowed(r, 'the park made a card');
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
  assertAllowed(runCard('nocard-bypass', [GIT_PUSH], 'Pushed a typo fix.\nNO-CARD: one-character typo in a comment\n\nKEEP OPEN — deploy running.'), 'NO-CARD with a reason');
  assertBlocked(runCard('nocard-bypass-short', [GIT_PUSH], 'Pushed.\nNO-CARD: typo\n\nKEEP OPEN — deploy running.'), 'NO-CARD needs 10+ chars');
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
  const r = runHook(transcript, 'Pushed and closed the card.\n\nSAFE TO ARCHIVE — done.');
  assertBlocked(r, 'the card is still open after a refused update');
  assert.match(r.stderr, /Linear card was never closed out/i, `got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('NOWRAPUP: a close-out the harness flagged is_error (denied or crashed) is not a close-out → BLOCKED', skipNoRepoHook, () => {
  for (const result of [
    'Permission for this action was denied by the Claude Code auto mode classifier.',
    'Exit code 1\nError: getaddrinfo EAI_AGAIN api.linear.app',
  ]) {
    const dir = makeTmpDir('wrapup-linear-errored');
    const errored = { ...toolUse('Bash', { command: 'node scripts/linear-brain.js update BRO-9001 --state Done' }, result), _isError: true };
    const transcript = writeTranscript(dir, [GIT_PUSH, errored]);
    const r = runHook(transcript, 'Pushed and closed the card.\n\nSAFE TO ARCHIVE — done.');
    assertBlocked(r, `an errored close-out left the card open: ${result.slice(0, 30)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NOWRAPUP: linear-session report --status=done (claimed issue) → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-linear-report');
  const report = toolUse('Bash', { command: 'node scripts/linear-session.js report --issue=BRO-4201 --status=done --summary="shipped"' }, '__LINEAR_ISSUE_ID__=abc12345-0000\n{"identifier":"BRO-4201","status":"done","stateName":"Done","doneGateRefused":false}');
  const transcript = writeTranscript(dir, [GIT_PUSH, report]);
  const r = runHook(transcript, 'Pushed and reported.\n\nSAFE TO ARCHIVE — reported done.');
  assertAllowed(r, 'report is the close-out verb for a claimed issue');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('NOWRAPUP: linear-session report whose done-gate refused → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-linear-report-refused');
  const report = toolUse('Bash', { command: 'node scripts/linear-session.js report --issue=BRO-4201 --status=done --summary="shipped"' }, '{"identifier":"BRO-4201","status":"done","stateName":"In Progress","doneGateRefused":true}\n❌ REFUSED (no-evidence)');
  const transcript = writeTranscript(dir, [GIT_PUSH, report]);
  const r = runHook(transcript, 'Pushed and reported.\n\nSAFE TO ARCHIVE — reported done.');
  assertBlocked(r, 'a refused report leaves the card open');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('NOWRAPUP fails open when Linear is unreachable', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-linear-down');
  const transcript = writeTranscript(dir, [GIT_PUSH]);
  const r = runHook(transcript, 'Pushed.\n\nSAFE TO ARCHIVE — pushed.', { STUB_PROBE_EXIT: '4' });
  assertAllowed(r, 'a session cannot close out on a board it cannot reach');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────── ship-check findings (2026-09-28): fall-through + phrasing ───────
// A stood-down board gate (Linear down / escape hatch) must fall through to
// every later gate, not exit the hook. The first draft exited from bash and
// skipped UNVERIFIED/scoring/PR gates — Linear down replayed the incident.

test('P0 regression: NOCARD standing down (Linear unreachable) still runs the UNVERIFIED gate → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('nocard-fallthrough');
  const transcript = writeTranscript(dir, [QUALIFYING_EDIT], { card: false });
  const r = runHook(transcript, 'Edited scoring.ts.\n\nKEEP OPEN — not verified yet.', { STUB_PROBE_EXIT: '4' });
  assertBlocked(r, 'a stood-down card gate must not wave through an unverified edit');
  assert.match(r.stderr, /unverified edit/i, `got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P0 regression: NOWRAPUP standing down (Linear unreachable) still runs the UNVERIFIED gate → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('nowrapup-fallthrough');
  const transcript = writeTranscript(dir, [QUALIFYING_EDIT, SHIP_CHECK, WHAT_ELSE, WRAP_UP, GIT_PUSH]);
  const r = runHook(transcript, 'Pushed.\n\nSAFE TO ARCHIVE — pushed.', { STUB_PROBE_EXIT: '4' });
  assertBlocked(r, 'a stood-down close-out gate must not wave through an unverified edit');
  assert.match(r.stderr, /unverified edit/i, `got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P0 regression: escape hatch on, no card, PR parked → the PR gate still fires', skipNoRepoHook, () => {
  const dir = makeTmpDir('hatch-pr');
  const transcript = writeTranscript(dir, [CREATE_PR], { card: false });
  const r = runHook(transcript, 'Opened PR #42.\n\nKEEP OPEN — PR open.', { BOARD_GATE_DISABLED: '1' });
  assertBlocked(r, 'the board escape hatch must not disable the PR gate');
  assert.match(r.stderr, /land it yourself/i, `got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ordering: no card AND a parked PR → the PR gate fires first', skipNoRepoHook, () => {
  const dir = makeTmpDir('order-pr-first');
  const transcript = writeTranscript(dir, [CREATE_PR], { card: false });
  const r = runHook(transcript, 'KEEP OPEN — PR #947 still open and unreviewed.');
  assertBlocked(r, 'parked PR without a card');
  assert.match(r.stderr, /never merges or reviews/i, `got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const [label, msg] of [
  ['blocked-owners-review', "Everything's green.\n\nKEEP OPEN — blocked on the owner's review of PR #947."],
  ['blocked-signoff', 'Green.\n\nKEEP OPEN — blocked on your sign-off.'],
  ['checks-pending-approval', 'KEEP OPEN — checks pending your approval.'],
  ['please-review', 'Please review PR #947 when you can; CI still running.\n\nKEEP OPEN — CI still running.'],
  ['pr-blocker-owner', 'PR-BLOCKER: waiting for the owner to look at it\n\nKEEP OPEN — see blocker.'],
]) {
  test(`false-pass closed: "${msg.split('\n').pop().slice(0, 60)}" → BLOCKED`, skipNoRepoHook, () => {
    const r = runOnPr(`fp-${label}`, msg);
    assertBlocked(r, 'a review ask in any wording must block');
  });
}

for (const [label, msg] of [
  ['waiting-for-ci', 'Opened PR #42.\n\nKEEP OPEN — waiting for CI on PR #42.'],
  ['ci-apostrophe', "KEEP OPEN — CI's still running on PR #42."],
  ['ci-currently', 'KEEP OPEN — CI is currently running.'],
  ['testyml-running', 'KEEP OPEN — test.yml is running.'],
  ['land-run-running', 'KEEP OPEN — Land run still running.'],
  ['ci-failed', 'CI failed on PR #42 (tsc). Fixing.\n\nKEEP OPEN — fixing CI.'],
  ['merge-conflicts', 'KEEP OPEN — merge conflicts with main on PR #42.'],
  ['bold-decision', '**DECISION NEEDED:** pricing tier for /biz.\n\nACTION NEEDED FROM YOU — answer the decision.'],
  ['bullet-pr-blocker', '- PR-BLOCKER: land.yml refused: tsc error in src/lib/scoring.ts\n\nKEEP OPEN — fixing.'],
]) {
  test(`false-block closed: "${msg.split('\n').pop().slice(0, 60)}" → ALLOWED`, skipNoRepoHook, () => {
    const r = runOnPr(`fb-${label}`, msg);
    assertAllowed(r, 'a legitimate technical wait must pass');
  });
}

for (const [label, msg] of [
  ['without-waiting', 'Landed via land/fix-x without waiting for review.\n\nSAFE TO ARCHIVE — landed and verified.'],
  ['no-need', 'Landed; no need for your review.\n\nSAFE TO ARCHIVE — landed and verified.'],
  ['doesnt-need', "Landed. This doesn't need a review.\n\nSAFE TO ARCHIVE — landed and verified."],
]) {
  test(`negated review wording after a land is not an ask (${label}) → ALLOWED`, skipNoRepoHook, () => {
    const dir = makeTmpDir(`neg-${label}`);
    const transcript = writeTranscript(dir, [CREATE_PR, LAND_PUSH, LAND_RUN_CHECK, LINEAR_CLOSEOUT_DONE]);
    const r = runHook(transcript, msg);
    assertAllowed(r, 'describing that no review is needed must not trip OWNERMERGE');
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('NOCARD: a scratch analysis script in /tmp is not repo work → ALLOWED without a card', skipNoRepoHook, () => {
  const r = runCard('nocard-scratch', [
    toolUse('Write', { file_path: '/tmp/claude-0/x/scratchpad/analyze.py', content: 'print(1)' }),
    toolUse('Bash', { command: 'python3 /tmp/claude-0/x/scratchpad/analyze.py' }),
  ], 'The answer is 1.\n\nKEEP OPEN — just answered a question.');
  assertAllowed(r, 'throwaway scripts outside the repo need no card');
});

test('NOCARD: create output truncated by `| tail -3` still counts (BRO id survives) → ALLOWED', skipNoRepoHook, () => {
  const create = toolUse('Bash', { command: 'node scripts/linear-brain.js create "x" --dispatch --notes "y" 2>&1 | tail -3' }, 'ISSUE-FILED: BRO-9005 ("x") — state=Todo\n\n⚠️  ACCEPTANCE CRITERIA DO NOT ARM — this card cannot be closed as filed.');
  assertAllowed(runCard('nocard-tail', [create, GIT_PUSH], NOT_SAFE), 'the BRO id in the create result is enough');
});

test('NOCARD: create piped to `jq -r .identifier` (bare BRO-N) → ALLOWED', skipNoRepoHook, () => {
  const create = toolUse('Bash', { command: 'node scripts/linear-brain.js create "x" --dispatch --notes "y" 2>/dev/null | jq -r .identifier' }, 'BRO-9006');
  assertAllowed(runCard('nocard-jq', [create, GIT_PUSH], NOT_SAFE), 'a bare identifier from the create command counts');
});

test('NOWRAPUP: ECONNREFUSED in a retried-but-successful close-out is not a refusal → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-econnrefused');
  const closeout = toolUse('Bash', { command: 'node scripts/linear-brain.js update BRO-9001 --state Done --comment "PR-EVIDENCE: merged deployed checked (x)"' }, '⏳ Linear HTTP retry 1 (ECONNREFUSED)\n{"identifier":"BRO-9001","state":"Done"}\nISSUE-UPDATED: BRO-9001 — state=Done — commented');
  const transcript = writeTranscript(dir, [GIT_PUSH, closeout]);
  const r = runHook(transcript, 'Pushed and closed.\n\nSAFE TO ARCHIVE — card Done.');
  assertAllowed(r, 'REFUSED must be word-anchored');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Close-out by pausing: `--state Backlog` (or `--state Paused` once the team
// has that state, BRO-2857) is a close-out. This fixture covers the Backlog form.
test('NOWRAPUP: linear-brain --state Backlog is a close-out → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-backlog');
  const closeout = toolUse('Bash', { command: 'node scripts/linear-brain.js update BRO-9007 --state Backlog --comment "parked"' }, 'ISSUE-UPDATED: BRO-9007 — state=Backlog — commented');
  const transcript = writeTranscript(dir, [GIT_PUSH, closeout]);
  const r = runHook(transcript, 'Pushed and parked.\n\nSAFE TO ARCHIVE — card parked.');
  assertAllowed(r, 'Backlog is how Linear spells a pause');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('NOWRAPUP: linear-brain --state Paused (rejected by Linear) is not a close-out → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wrapup-paused-rejected');
  const closeout = toolUse('Bash', { command: 'node scripts/linear-brain.js update BRO-9008 --state Paused' }, '❌ unknown state "Paused". Valid states: In Review, Canceled, Todo, Backlog, Duplicate, Done, In Progress');
  const transcript = writeTranscript(dir, [GIT_PUSH, closeout]);
  const r = runHook(transcript, 'Pushed and paused.\n\nSAFE TO ARCHIVE — card paused.');
  assertBlocked(r, 'a rejected state change left the card open');
  assert.match(r.stderr, /status=paused/, `got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── In-flight-work gate (INFLIGHT, 2026-09-28) ─────────────────────────────
// Owner evidence: a session with ten background agents, a Land run and two
// scheduled check-ins in flight closed a turn on "SAFE TO ARCHIVE"; the owner
// reads that line as "kill this session now". These fixtures mirror the real
// transcript shapes: agentId in the Agent tool_result, trigger ids in the
// send_later / create_trigger tool_result JSON, and completions as
// STRING-content user records (see notice()).
const AGENT_ID = 'a0ef4eb5c89b9f21b';
const AGENT_BG = toolUse('Agent', { description: 'S4 agent A', prompt: 'do the thing', run_in_background: true },
  `Async agent launched successfully.\nagentId: ${AGENT_ID} (internal ID - do not mention to user.)\nThe agent is working in the background.`);
const AGENT_FG = toolUse('Agent', { description: 'quick lookup', prompt: 'look' }, 'Here is the answer: 42.');
// Real foreground result shape (2026-10-11 transcript): inline report, then the agentId line.
const AGENT_FG_REAL = toolUse('Agent', { description: 'Second-opinion plan review', prompt: 'review', run_in_background: false },
  '[Subagent hand-back] The report follows:\n  VERDICT: revise\nagentId: a81317ffd0f40b257 (use SendMessage with to: \'a81317ffd0f40b257\', summary: \'<5-10 word recap>\' to continue this agent)\n<usage>subagent_tokens: 60360</usage>');
const AGENT_DONE = notice(`<task-notification>\n<task-id>${AGENT_ID}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>completed</status>\n<summary>Agent "S4 agent A" finished</summary>\n</task-notification>`);
const AGENT_FAILED = notice(`<task-notification>\n<task-id>${AGENT_ID}</task-id>\n<status>failed</status>\n<summary>Agent "S4 agent A" failed</summary>\n</task-notification>`);
const AGENT_HANDBACK = notice(`Another Claude session sent a message:\n<agent-message from="${AGENT_ID}">\n[Subagent hand-back] The report follows:\n  done, nothing edited\n</agent-message>`);
const AGENT_RESUME = toolUse('SendMessage', { to: AGENT_ID, summary: 'one more thing', message: 'also check X' }, 'Message sent.');
const AGENT_STOP = toolUse('TaskStop', { task_id: AGENT_ID }, 'Stopped.');
const FAR = '2099-01-01T12:00:00Z';
const PAST = '2001-01-01T12:00:00Z';
const SEND_LATER_FUTURE = toolUse('mcp__Claude_Code_Remote__send_later', { delay_minutes: 60, message: 'Land check-in: re-check run 123' },
  `{"fire_at":"${FAR}","now":"2026-09-28T20:08:23Z","trigger_id":"trig_01FUTURE"}`);
const SEND_LATER_FIRED = toolUse('mcp__Claude_Code_Remote__send_later', { delay_minutes: 1, message: 'Land check-in: re-check run 123' },
  `{"fire_at":"${PAST}","now":"2001-01-01T11:59:00Z","trigger_id":"trig_01PAST"}`);
const SEND_LATER_FAILED = toolUse('mcp__Claude_Code_Remote__send_later', { delay_minutes: 60, message: 'x' }, 'Error: rate limited');
const DELETE_FUTURE = toolUse('mcp__Claude_Code_Remote__delete_trigger', { trigger_id: 'trig_01FUTURE' }, '{"trigger":{"id":"trig_01FUTURE","name":"Land check-in"}}');
const CRON_SELF = toolUse('mcp__Claude_Code_Remote__create_trigger', { name: 'hourly poll', prompt: 'poll CI', cron_expression: '0 * * * *', initiation: 'own_followup' },
  '{"trigger":{"id":"trig_01CRON","name":"hourly poll","cron_expression":"0 * * * *","enabled":true,"persist_session":true}}');
const CRON_DISABLE = toolUse('mcp__Claude_Code_Remote__update_trigger', { trigger_id: 'trig_01CRON', enabled: false }, '{"trigger":{"id":"trig_01CRON","enabled":false}}');
const CRON_OTHER_SESSION = toolUse('mcp__Claude_Code_Remote__create_trigger', { name: 'nightly', prompt: 'run', cron_expression: '0 3 * * *', create_new_session_on_fire: true, initiation: 'human_request' },
  '{"trigger":{"id":"trig_01FRESH","name":"nightly","cron_expression":"0 3 * * *","enabled":true}}');
const ONESHOT_PUSHED = toolUse('mcp__Claude_Code_Remote__update_trigger', { trigger_id: 'trig_01PAST', run_once_at: FAR }, '{"trigger":{"id":"trig_01PAST","run_once_at":"' + FAR + '"}}');
const SAFE_MSG = 'All done.\n\nSAFE TO ARCHIVE — nothing outstanding.';
const NOT_SAFE_MSG = 'Agents still running.\n\nKEEP OPEN — one background agent still working; it hands back when done.';

function assertInflight(r, message) {
  assertBlocked(r, message);
  assert.match(r.stderr, /in flight/i, `expected the INFLIGHT message, got: ${r.stderr.slice(0, 400)}`);
}

test('INFLIGHT: background Agent launched, no completion notice, SAFE TO ARCHIVE → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-agent');
  const transcript = writeTranscript(dir, [AGENT_BG, LINEAR_CLOSEOUT_DONE]);
  const r = runHook(transcript, SAFE_MSG);
  assertInflight(r, 'a live background agent dies with the session');
  assert.match(r.stderr, new RegExp(AGENT_ID), 'the block names the live agent id');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT: same transcript with KEEP OPEN → ALLOWED (the honest line while work is in flight)', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-agent-notsafe');
  const transcript = writeTranscript(dir, [AGENT_BG]);
  assertAllowed(runHook(transcript, NOT_SAFE_MSG), 'KEEP OPEN is what the gate asks for');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT: agent completion arrives as a STRING-content <task-notification> → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-agent-done');
  const transcript = writeTranscript(dir, [AGENT_BG, AGENT_DONE, LINEAR_CLOSEOUT_DONE]);
  assertAllowed(runHook(transcript, SAFE_MSG), 'a completed agent is not in flight');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT: completion delivered mid-turn as an `attachment` record (queued_command prompt), no user record → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-agent-attachment');
  const done = attachmentNotice(`<task-notification>\n<task-id>${AGENT_ID}</task-id>\n<status>completed</status>\n<summary>Agent "S4 agent A" finished</summary>\n</task-notification>`);
  assertAllowed(runHook(writeTranscript(dir, [AGENT_BG, done, LINEAR_CLOSEOUT_DONE]), SAFE_MSG), 'mid-turn delivery shape must count');
  const handback = attachmentNotice(`<agent-message from="${AGENT_ID}">\n[Subagent hand-back] report\n</agent-message>`);
  assertAllowed(runHook(writeTranscript(dir, [AGENT_BG, handback, LINEAR_CLOSEOUT_DONE]), SAFE_MSG), 'mid-turn hand-back shape must count');
  const unrelated = attachmentNotice('<task-notification>\n<task-id>someone-else</task-id>\n<status>completed</status>\n</task-notification>');
  assertInflight(runHook(writeTranscript(dir, [AGENT_BG, unrelated, LINEAR_CLOSEOUT_DONE]), SAFE_MSG), 'a notice for a different id does not complete this agent');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT: <status>failed</status> notice also completes the agent → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-agent-failed');
  const transcript = writeTranscript(dir, [AGENT_BG, AGENT_FAILED, LINEAR_CLOSEOUT_DONE]);
  assertAllowed(runHook(transcript, SAFE_MSG), 'a failed agent is finished, not live');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT: <agent-message from=…> hand-back completes the agent → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-agent-handback');
  const transcript = writeTranscript(dir, [AGENT_BG, AGENT_HANDBACK, LINEAR_CLOSEOUT_DONE]);
  assertAllowed(runHook(transcript, SAFE_MSG), 'the hand-back is the completion');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT: TaskStop on the agent completes it → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-agent-stop');
  const transcript = writeTranscript(dir, [AGENT_BG, AGENT_STOP, LINEAR_CLOSEOUT_DONE]);
  assertAllowed(runHook(transcript, SAFE_MSG), 'a stopped agent is not live');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT: SendMessage to a finished agent resumes it — live again until its next completion → BLOCKED, then ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-agent-resume');
  const blocked = writeTranscript(dir, [AGENT_BG, AGENT_DONE, AGENT_RESUME, LINEAR_CLOSEOUT_DONE]);
  assertInflight(runHook(blocked, SAFE_MSG), 'a resumed agent is in flight again');
  const allowed = writeTranscript(dir, [AGENT_BG, AGENT_DONE, AGENT_RESUME, AGENT_HANDBACK, LINEAR_CLOSEOUT_DONE]);
  assertAllowed(runHook(allowed, SAFE_MSG), 'its second hand-back completes it');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT false-positive guard: a foreground Agent (report returned inline, no agentId) is never in flight', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-agent-fg');
  const transcript = writeTranscript(dir, [AGENT_FG, LINEAR_CLOSEOUT_DONE]);
  assertAllowed(runHook(transcript, SAFE_MSG), 'foreground agents finish before the tool returns');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT false-positive guard: a real foreground Agent result that also prints its agentId is finished', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-agent-fg-real');
  assertAllowed(runHook(writeTranscript(dir, [AGENT_FG_REAL, LINEAR_CLOSEOUT_DONE]), SAFE_MSG), 'the report came back inline');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT false-positive guard: a background Bash command is deliberately NOT tracked', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-bash-bg');
  const bg = toolUse('Bash', { command: 'sleep 999', run_in_background: true, description: 'wait' },
    'Command running in background with ID: b1e9y745t. Output is being written to: /tmp/x.output.');
  const transcript = writeTranscript(dir, [bg, LINEAR_CLOSEOUT_DONE]);
  assertAllowed(runHook(transcript, SAFE_MSG), 'two of four background commands in a real transcript finished with no notice');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT: self-bound send_later still ahead of now, never deleted, SAFE TO ARCHIVE → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-sendlater');
  const transcript = writeTranscript(dir, [SEND_LATER_FUTURE, LINEAR_CLOSEOUT_DONE]);
  const r = runHook(transcript, SAFE_MSG);
  assertInflight(r, 'a check-in scheduled into this session dies with it');
  assert.match(r.stderr, /trig_01FUTURE/, 'the block names the trigger id');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT: send_later deleted via delete_trigger → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-sendlater-deleted');
  const transcript = writeTranscript(dir, [SEND_LATER_FUTURE, DELETE_FUTURE, LINEAR_CLOSEOUT_DONE]);
  assertAllowed(runHook(transcript, SAFE_MSG), 'a deleted trigger is not in flight');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT: send_later whose fire_at is already past has fired → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-sendlater-fired');
  const transcript = writeTranscript(dir, [SEND_LATER_FIRED, LINEAR_CLOSEOUT_DONE]);
  assertAllowed(runHook(transcript, SAFE_MSG), 'the firing never echoes the id; time is the signal');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT: update_trigger pushing a fired one-shot\'s run_once_at into the future re-arms it → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-sendlater-pushed');
  const transcript = writeTranscript(dir, [SEND_LATER_FIRED, ONESHOT_PUSHED, LINEAR_CLOSEOUT_DONE]);
  assertInflight(runHook(transcript, SAFE_MSG), 'the re-armed one-shot is live again');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT: a failed send_later call (no trigger id in its result) schedules nothing → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-sendlater-failed');
  const transcript = writeTranscript(dir, [SEND_LATER_FAILED, LINEAR_CLOSEOUT_DONE]);
  assertAllowed(runHook(transcript, SAFE_MSG), 'nothing was scheduled');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT: self-bound cron Routine (create_trigger result shape {"trigger":{"id"}}) never deleted → BLOCKED; disabled via update_trigger → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-cron');
  assertInflight(runHook(writeTranscript(dir, [CRON_SELF, LINEAR_CLOSEOUT_DONE]), SAFE_MSG), 'a recurring wake-up into this session is live until deleted');
  assertAllowed(runHook(writeTranscript(dir, [CRON_SELF, CRON_DISABLE, LINEAR_CLOSEOUT_DONE]), SAFE_MSG), 'enabled:false ends it');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT false-positive guard: a Routine that fires into a fresh or other session is not this session\'s to keep alive', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-cron-other');
  const other = toolUse('mcp__Claude_Code_Remote__create_trigger', { name: 'wake sibling', prompt: 'go', run_once_at: FAR, persistent_session_id: 'session_01XYZ', initiation: 'own_followup' },
    '{"trigger":{"id":"trig_01SIBLING","run_once_at":"' + FAR + '"}}');
  const transcript = writeTranscript(dir, [CRON_OTHER_SESSION, other, LINEAR_CLOSEOUT_DONE]);
  assertAllowed(runHook(transcript, SAFE_MSG), 'create_new_session_on_fire / persistent_session_id Routines survive this session');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT precedence: it blocks before the wrap-up gate, and KEEP OPEN with a live agent needs no close-out', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-precedence');
  // Work done, no Linear close-out, live agent: the message must be INFLIGHT
  // (what to fix first), not NOWRAPUP.
  const r = runHook(writeTranscript(dir, [GIT_PUSH, AGENT_BG]), SAFE_MSG);
  assertInflight(r, 'in-flight work is reported before the missing close-out');
  assert.doesNotMatch(r.stderr, /Linear card was never closed out/, 'one block per turn: INFLIGHT, not NOWRAPUP');
  assertAllowed(runHook(writeTranscript(dir, [GIT_PUSH, AGENT_BG]), NOT_SAFE_MSG), 'the honest line passes every gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT: independent of SESSION_STATUS_GATE_DISABLE (own last-line parse, no shared locals)', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-independent');
  const transcript = writeTranscript(dir, [AGENT_BG, LINEAR_CLOSEOUT_DONE]);
  assertInflight(runHook(transcript, SAFE_MSG, { SESSION_STATUS_GATE_DISABLE: '1' }), 'disabling the status-line gate must not disable this one');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT bypass: NO-VERIFY: allows SAFE TO ARCHIVE with a live agent', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-noverify');
  const transcript = writeTranscript(dir, [AGENT_BG, LINEAR_CLOSEOUT_DONE]);
  assertAllowed(runHook(transcript, 'NO-VERIFY: owner asked to end now, agent is throwaway.\n\nSAFE TO ARCHIVE — per owner.'), 'explicit bypass');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT kill switch: INFLIGHT_GATE_DISABLE=1', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-killswitch');
  const transcript = writeTranscript(dir, [AGENT_BG, LINEAR_CLOSEOUT_DONE]);
  assertAllowed(runHook(transcript, SAFE_MSG, { INFLIGHT_GATE_DISABLE: '1' }), 'kill switch');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT false-positive guard: a fenced example containing "SAFE TO ARCHIVE" is not a claim; the real last line is NOT SAFE', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-fenced');
  const transcript = writeTranscript(dir, [AGENT_BG]);
  assertAllowed(runHook(transcript, 'Example line:\n```\nSAFE TO ARCHIVE — example\n```\n\nKEEP OPEN — agent still running.'), 'fenced text is stripped');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('regression: existing user_text consumers unchanged — a STRING-content owner prompt does not become user_text (NO-VERIFY turn boundary untouched)', skipNoRepoHook, () => {
  // The parser now emits string-content user records as 'user_notice', a kind
  // only the in-flight gate reads. A string prompt between an edit and its
  // verification must not change any other gate's outcome vs. before.
  const dir = makeTmpDir('inflight-user-notice-isolated');
  const transcript = writeTranscript(dir, [GIT_PUSH, notice('owner typed something'), LINEAR_CLOSEOUT_DONE]);
  assertAllowed(runHook(transcript, SAFE_MSG), 'a plain string user record is inert for every other gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

// BRO-4238: github-main-guard.sh refuses Broadwayscore PR merges. A refused
// merge attempt must not count as "the PR was merged" and switch off the
// follow-through gate.
test('PR gate: a merge attempt the hook BLOCKED does not count as merged → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('blocked-merge');
  const blockedMerge = toolUse('mcp__github__merge_pull_request', { owner: 'thomaspryor', repo: 'Broadwayscore', pullNumber: 1 },
    'PreToolUse:mcp__github__merge_pull_request hook error: 🛑 BLOCKED: PRs in thomaspryor/Broadwayscore are never merged directly (BRO-4238)');
  const transcript = writeTranscript(dir, [CREATE_PR, blockedMerge, LINEAR_CLOSEOUT_DONE]);
  assertBlocked(runHook(transcript, 'Merged PR #1.\n\nSAFE TO ARCHIVE — merged.'), 'a blocked merge left the PR open');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PR gate: a merge the API or the permission layer refused does not count as merged → BLOCKED', skipNoRepoHook, () => {
  // Real failure shapes carry no "error" word (ship-check review, BRO-4238).
  for (const result of [
    'failed to merge pull request: PUT https://api.github.com/repos/o/r/pulls/1/merge: 405 Pull Request is not mergeable []',
    'failed to merge pull request: 409 Head branch was modified. Review and try the merge again.',
    'Permission for this action was denied by the Claude Code auto mode classifier.',
    '<tool_use_error>InputValidationError: pullNumber must be a number</tool_use_error>',
  ]) {
    const dir = makeTmpDir('failed-merge');
    const failed = toolUse('mcp__github__merge_pull_request', { owner: 'someone', repo: 'other', pullNumber: 1 }, result);
    const transcript = writeTranscript(dir, [CREATE_PR, failed, LINEAR_CLOSEOUT_DONE]);
    assertBlocked(runHook(transcript, 'Merged PR #1.\n\nSAFE TO ARCHIVE — merged.'), `refused merge counted as merged: ${result.slice(0, 40)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PR gate: a merge that went through still counts (unchanged) → ALLOWED', skipNoRepoHook, () => {
  const dir = makeTmpDir('real-merge');
  const transcript = writeTranscript(dir, [CREATE_PR, MERGE_PR, LINEAR_CLOSEOUT_DONE]);
  assertAllowed(runHook(transcript, 'Merged PR #1.\n\nSAFE TO ARCHIVE — merged.'), 'a real merge closes the PR out');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────── cloud finish-line chain (BRO-4238 phase 2, 2026-09-29) ─────────
// Port of the Mac finish-line gate's review + /what-else checks. Incident:
// this very session edited .claude/hooks/*.sh, claimed SAFE TO ARCHIVE, and ran
// neither /ship-check nor /what-else until the owner asked.
const HOOK_EDIT = toolUse('Edit', { file_path: '/home/user/Broadwayscore/.claude/hooks/github-main-guard.sh', old_string: 'a', new_string: 'b' });
const HOOK_RUN = toolUse('Bash', { command: 'bash .claude/hooks/github-main-guard.sh < payload.json' });
const WORKFLOW_EDIT = toolUse('Edit', { file_path: '/home/user/Broadwayscore/.github/workflows/test.yml', old_string: 'a', new_string: 'b' });
const DOC_EDIT = toolUse('Edit', { file_path: '/home/user/Broadwayscore/.claude/CLOUD.md', old_string: 'a', new_string: 'b' });
const OWNER = (text) => ({ _notice: text });
const HOOK_FEEDBACK = { _notice: 'Stop hook feedback:\n🛑 BLOCKED: …', _isMeta: true };
const CLOSED = 'Landed and verified.\n\nSAFE TO ARCHIVE — landed, card updated.';

function chain(name, calls, msg, env) {
  const dir = makeTmpDir(name);
  const r = runHook(writeTranscript(dir, calls), msg, env);
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

test('chain: hook edit + SAFE TO ARCHIVE with no review → BLOCKED (the incident)', skipNoRepoHook, () => {
  const r = chain('chain-noreview', [HOOK_EDIT, HOOK_RUN, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED);
  assertBlocked(r, 'unreviewed hook edit');
  assert.match(r.stderr, /github-main-guard\.sh.*finish chain is incomplete.*\/ship-check/s, `got: ${r.stderr.slice(0, 300)}`);
});

test('chain: reviewed but /what-else never ran → BLOCKED', skipNoRepoHook, () => {
  const r = chain('chain-nowhatelse', [HOOK_EDIT, HOOK_RUN, SHIP_CHECK, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED);
  assertBlocked(r, 'no what-else');
  assert.match(r.stderr, /Still to run.*\/what-else, then \/wrap-up/, `got: ${r.stderr.slice(0, 300)}`);
});

test('chain: review + what-else → ALLOWED; second-opinion counts as the review', skipNoRepoHook, () => {
  assertAllowed(chain('chain-full', [HOOK_EDIT, HOOK_RUN, SHIP_CHECK, WHAT_ELSE, WRAP_UP, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED), 'full chain');
  const so = toolUse('Skill', { skill: 'second-opinion' });
  assertAllowed(chain('chain-so', [HOOK_EDIT, HOOK_RUN, so, WHAT_ELSE, WRAP_UP, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED), 'second-opinion');
});

test('chain: fixups right after the review are covered; stop-hook feedback does not end the fixup window', skipNoRepoHook, () => {
  assertAllowed(chain('chain-fixups', [HOOK_EDIT, SHIP_CHECK, HOOK_EDIT, HOOK_FEEDBACK, HOOK_EDIT, HOOK_RUN, WHAT_ELSE, WRAP_UP, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED),
    'two fixups after the review');
  const many = Array(9).fill(HOOK_EDIT);
  assertBlocked(chain('chain-fixups-over', [HOOK_EDIT, SHIP_CHECK, ...many, HOOK_RUN, WHAT_ELSE, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED),
    'nine edits after a review is new work, not fixups');
});

test('chain: new work after the owner speaks again needs a new review and a new /what-else', skipNoRepoHook, () => {
  const r = chain('chain-newwork', [HOOK_EDIT, SHIP_CHECK, WHAT_ELSE, OWNER('Sure do it now'), HOOK_EDIT, HOOK_RUN, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED);
  assertBlocked(r, 'edit after a new owner message');
  assert.match(r.stderr, /Still to run.*\/ship-check/, `got: ${r.stderr.slice(0, 300)}`);
  const r2 = chain('chain-newwork-reviewed', [HOOK_EDIT, SHIP_CHECK, WHAT_ELSE, OWNER('Sure do it now'), HOOK_EDIT, HOOK_RUN, SHIP_CHECK, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED);
  assert.match(r2.stderr, /does not count\): \/what-else, then \/wrap-up/, `the earlier /what-else covered the earlier work only; got: ${r2.stderr.slice(0, 300)}`);
});

test('chain: workflow edits count (they used to be skipped entirely)', skipNoRepoHook, () => {
  assertBlocked(chain('chain-workflow', [WORKFLOW_EDIT, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED), 'unreviewed workflow edit');
});

test('chain: mid-work stops, docs-only edits, bypass lines and the kill switch are not blocked', skipNoRepoHook, () => {
  assertAllowed(chain('chain-notsafe', [HOOK_EDIT, HOOK_RUN, GIT_PUSH, LINEAR_CLOSEOUT_DONE], 'Step 1 of 3 done.\n\nKEEP OPEN — landing still running.'), 'mid-work');
  assertAllowed(chain('chain-docs', [DOC_EDIT, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED), 'docs only');
  assertAllowed(chain('chain-bypass', [HOOK_EDIT, HOOK_RUN, GIT_PUSH, LINEAR_CLOSEOUT_DONE],
    'NO-SHIP-CHECK: reverted my own change byte-for-byte, nothing new to review\nNO-WHAT-ELSE: pure revert, nothing adjacent\nNO-WRAP-UP: closed out the card by hand for a pure revert\n\nSAFE TO ARCHIVE — reverted.'), 'bypass lines');
  // NO-VERIFY waives execution evidence only, never the review.
  assertBlocked(chain('chain-noverify', [HOOK_EDIT, HOOK_RUN, WHAT_ELSE, GIT_PUSH, LINEAR_CLOSEOUT_DONE],
    'NO-VERIFY: ran it by hand in the container\n\nSAFE TO ARCHIVE — done.'), 'NO-VERIFY must not waive the review');
  assertAllowed(chain('chain-killswitch', [HOOK_EDIT, HOOK_RUN, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED, { CLOUD_CHAIN_GATE_DISABLE: '1' }), 'kill switch');
});

// ship-check review findings (2026-09-29), each reproduced before the fix.
const COMPACTION = { _notice: 'This session is being continued from a previous conversation that ran out of context.', _extra: { isCompactSummary: true } };
const OWNER_SLASH = (name) => ({ _notice: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>`, _extra: { origin: null } });

test('chain: a compaction summary is not an owner message (fixups and /what-else survive it)', skipNoRepoHook, () => {
  assertAllowed(chain('chain-compaction', [HOOK_EDIT, SHIP_CHECK, WHAT_ELSE, WRAP_UP, COMPACTION, HOOK_EDIT, HOOK_RUN, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED),
    'compaction must not start new work');
});

test('chain: /ship-check, /what-else and /wrap-up typed by the owner count', skipNoRepoHook, () => {
  assertAllowed(chain('chain-slash', [HOOK_EDIT, HOOK_RUN, OWNER_SLASH('ship-check'), OWNER_SLASH('what-else'), OWNER_SLASH('wrap-up'), GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED),
    'owner-typed slash commands');
});

test('chain: an owner message with an image attached starts new work', skipNoRepoHook, () => {
  const img = { _userList: [{ type: 'text', text: 'also fix this' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }] };
  assertBlocked(chain('chain-image', [HOOK_EDIT, SHIP_CHECK, WHAT_ELSE, img, HOOK_EDIT, HOOK_RUN, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED),
    'edit after an image message is new work');
});

test('chain: edits made through Bash count (sed -i, cat >, python open(..., "w"))', skipNoRepoHook, () => {
  for (const command of [
    "sed -i 's/a/b/' .claude/hooks/github-main-guard.sh",
    'cat > scripts/lib/new-helper.js <<EOF\nmodule.exports = 1;\nEOF',
    "python3 - <<'EOF'\np='.claude/hooks/verify-edits.sh'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF",
  ]) {
    assertBlocked(chain('chain-bashedit', [toolUse('Bash', { command }), HOOK_RUN, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED),
      `unreviewed Bash edit: ${command.slice(0, 30)}`);
  }
  // Reading or running code is not an edit.
  assertAllowed(chain('chain-bashread', [toolUse('Bash', { command: 'node scripts/foo.js > /tmp/out.txt && cat .claude/hooks/x.sh' }), GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED),
    'running a script is not a code edit');
});

test('chain: runs after the older gates, so an unrun edit still reports UNVERIFIED first', skipNoRepoHook, () => {
  const r = chain('chain-order', [QUALIFYING_EDIT, LINEAR_CLOSEOUT_DONE], 'SAFE TO ARCHIVE — done.');
  assertBlocked(r, 'unverified and unreviewed');
  assert.match(r.stderr, /unverified edit/i, `the execution gate must keep its block; got: ${r.stderr.slice(0, 300)}`);
});

test('NO-VERIFY from an earlier turn does not waive a later unverified edit (owner messages are strings)', skipNoRepoHook, () => {
  const earlier = { type: 'text', text: 'NO-VERIFY: docs-only tweak' };
  const dir = makeTmpDir('noverify-stale');
  const p = writeTranscript(dir, [QUALIFYING_EDIT, OWNER('now fix the scoring bug'), QUALIFYING_EDIT, SHIP_CHECK, WHAT_ELSE, LINEAR_CLOSEOUT_DONE]);
  // Put the old NO-VERIFY text before the owner's new message.
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  const ownerIdx = lines.findIndex((l) => l.includes('now fix the scoring bug'));
  lines.splice(ownerIdx, 0, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [earlier] } }));
  fs.writeFileSync(p, lines.join('\n') + '\n');
  const r = runHook(p, 'Fixed.\n\nSAFE TO ARCHIVE — done.');
  fs.rmSync(dir, { recursive: true, force: true });
  assertBlocked(r, 'a stale NO-VERIFY must not cover new work');
  assert.match(r.stderr, /unverified edit/i, `got: ${r.stderr.slice(0, 300)}`);
});

test('NOCARD: edits that a hook blocked are not work (BRO-4238 smoke test false positive)', skipNoRepoHook, () => {
  const dir = makeTmpDir('nocard-blocked');
  const blocked = { ...toolUse('Edit', { file_path: '/home/user/Broadwayscore/scripts/lib/review-gate.mjs', old_string: 'a', new_string: 'b' },
    'PreToolUse:Edit hook error: 🛑 INFRA PLAN REVIEW GATE: shared-infrastructure edit needs a review first'), _isError: true };
  const r = runHook(writeTranscript(dir, [blocked], { card: false }), 'The edit was refused, nothing changed.\n\nSAFE TO ARCHIVE — nothing changed.');
  fs.rmSync(dir, { recursive: true, force: true });
  assertAllowed(r, 'a refused edit is not work');
  // The same edit going through still needs a card.
  const dir2 = makeTmpDir('nocard-real');
  const r2 = runHook(writeTranscript(dir2, [QUALIFYING_EDIT, toolUse('Bash', { command: 'npx tsc --noEmit src/lib/scoring.ts' })], { card: false }), 'Done.\n\nSAFE TO ARCHIVE — done.');
  fs.rmSync(dir2, { recursive: true, force: true });
  assertBlocked(r2, 'a real edit without a card');
});

test('NOCARD: a push that ran but whose pipeline exited non-zero is still work', skipNoRepoHook, () => {
  // `git push ... 2>&1 | grep -v "^remote:"`: the push succeeds, grep filters
  // every line and exits 1, so the result is is_error "Exit code 1".
  const dir = makeTmpDir('nocard-exitcode');
  const push = { ...toolUse('Bash', { command: 'git push -q origin HEAD:refs/heads/wip/x 2>&1 | grep -v "^remote:"' }, 'Exit code 1'), _isError: true };
  const r = runHook(writeTranscript(dir, [push], { card: false }), 'Pushed.\n\nSAFE TO ARCHIVE — pushed.');
  fs.rmSync(dir, { recursive: true, force: true });
  assertBlocked(r, 'a push that ran is work and still needs a card');
});

// ─────────── Mac parity (BRO-4367, 2026-09-29) ─────────
// Incident: a cloud session ran /second-opinion plus an Agent "code review",
// did the wrap-up steps by hand and ended SAFE TO ARCHIVE; the gate let it pass.
const AGENT_REVIEW = toolUse('Agent', { description: 'Code review of the fix', prompt: 'review the diff' });
const CODEX_REVIEW = toolUse('Bash', { command: 'codex exec "review this diff"' });

test('parity: the incident (second-opinion + Agent review, wrap-up by hand) → BLOCKED for /wrap-up', skipNoRepoHook, () => {
  const so = toolUse('Skill', { skill: 'second-opinion' });
  const r = chain('parity-incident', [HOOK_EDIT, HOOK_RUN, so, AGENT_REVIEW, WHAT_ELSE, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED);
  assertBlocked(r, 'wrap-up done by hand');
  assert.match(r.stderr, /Still to run.*\/wrap-up/, `got: ${r.stderr.slice(0, 400)}`);
  assert.doesNotMatch(r.stderr, /does not count\): \/ship-check/, 'the review itself was fine');
});

test('parity: an Agent "review" or a codex call is not a chain review', skipNoRepoHook, () => {
  for (const [name, rev] of [['agent', AGENT_REVIEW], ['codex', CODEX_REVIEW]]) {
    const r = chain(`parity-${name}`, [HOOK_EDIT, HOOK_RUN, rev, WHAT_ELSE, WRAP_UP, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED);
    assertBlocked(r, `${name} review`);
    assert.match(r.stderr, /does not count\): \/ship-check/, `${name}: got ${r.stderr.slice(0, 300)}`);
  }
});

test('parity: a big session (>15 code edits) needs /ship-check or /code-review, not /second-opinion', skipNoRepoHook, () => {
  const edits = Array(16).fill(HOOK_EDIT);
  const so = toolUse('Skill', { skill: 'second-opinion' });
  const r = chain('parity-big-so', [...edits, HOOK_RUN, so, WHAT_ELSE, WRAP_UP, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED);
  assertBlocked(r, 'big session with only /second-opinion');
  assert.match(r.stderr, /too big for \/second-opinion/, `got: ${r.stderr.slice(0, 300)}`);
  assertAllowed(chain('parity-big-cr', [...edits, HOOK_RUN, OWNER_SLASH('code-review'), WHAT_ELSE, WRAP_UP, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED),
    'big session with owner-typed /code-review');
  assertAllowed(chain('parity-small-so', [HOOK_EDIT, HOOK_RUN, so, WHAT_ELSE, WRAP_UP, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED),
    'small session: /second-opinion still counts');
});

test('parity: every missing step is named in ONE block', skipNoRepoHook, () => {
  const r = chain('parity-all', [HOOK_EDIT, HOOK_RUN, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED);
  assertBlocked(r, 'nothing ran');
  assert.match(r.stderr, /does not count\): \/ship-check.*then \/what-else, then \/wrap-up/, `got: ${r.stderr.slice(0, 400)}`);
});

test('parity: a /wrap-up from before the owner\'s latest message does not cover new work', skipNoRepoHook, () => {
  const r = chain('parity-old-wrapup', [HOOK_EDIT, SHIP_CHECK, WHAT_ELSE, WRAP_UP, OWNER('one more fix please'), HOOK_EDIT, HOOK_RUN, SHIP_CHECK, WHAT_ELSE, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED);
  assertBlocked(r, 'stale wrap-up');
  assert.match(r.stderr, /does not count\): \/wrap-up/, `got: ${r.stderr.slice(0, 300)}`);
});

test('parity: namespaced skill names count; NO-WRAP-UP bypass works', skipNoRepoHook, () => {
  const ns = (n) => toolUse('Skill', { skill: `bsc:${n}` });
  assertAllowed(chain('parity-ns', [HOOK_EDIT, HOOK_RUN, ns('ship-check'), ns('what-else'), ns('wrap-up'), GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED), 'namespaced');
  assertAllowed(chain('parity-nowrap', [HOOK_EDIT, HOOK_RUN, SHIP_CHECK, WHAT_ELSE, GIT_PUSH, LINEAR_CLOSEOUT_DONE],
    'NO-WRAP-UP: owner asked to stop here, card closed above\n\nSAFE TO ARCHIVE — done.'), 'NO-WRAP-UP bypass');
});

// Per-gate loop guard (BRO-4367): the first block used to spend the whole
// turn-chain, so fixing one gate let every other gate through unchecked.
function chainFileFor(transcript) {
  const sum = spawnSync('bash', ['-c', 'printf "%s" "$1" | cksum | cut -d" " -f1', '_', transcript], { encoding: 'utf8' }).stdout.trim();
  return `/tmp/verify-edits-chain-${sum}`;
}

test('loop guard: a different gate still blocks after an earlier block; the same gate does not re-block', skipNoRepoHook, () => {
  const dir = makeTmpDir('loopguard');
  const t = writeTranscript(dir, [HOOK_EDIT, HOOK_RUN, GIT_PUSH, LINEAR_CLOSEOUT_DONE]);
  // 1st Stop: no status line.
  assertBlocked(runHook(t, 'All done here.'), 'no status line');
  // 2nd Stop in the same chain: status line fixed, chain still unrun → blocks.
  const r2 = runHook(t, CLOSED, {}, true);
  assertBlocked(r2, 'chain gate must still fire after an unrelated block');
  assert.match(r2.stderr, /finish chain is incomplete/, `got: ${r2.stderr.slice(0, 300)}`);
  // 3rd Stop: same gate again → let through (no infinite loop).
  assertAllowed(runHook(t, CLOSED, {}, true), 'same gate is not re-blocked in one chain');
  fs.rmSync(chainFileFor(t), { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loop guard: an already-fired gate falls through to the next gate instead of hiding it', skipNoRepoHook, () => {
  const dir = makeTmpDir('loopguard-fallthrough');
  // NOWRAPUP (card never closed) outranks the chain gate; UNVERIFIED (edit
  // never run) is a terminal verdict. Each fires once, then the chain shows.
  for (const [name, calls] of [['nowrapup', [HOOK_EDIT, HOOK_RUN, GIT_PUSH]], ['unverified', [QUALIFYING_EDIT, GIT_PUSH, LINEAR_CLOSEOUT_DONE]]]) {
    const t = writeTranscript(dir, calls);
    const first = runHook(t, CLOSED);
    assertBlocked(first, `${name}: first gate`);
    assert.doesNotMatch(first.stderr, /finish chain is incomplete/, `${name}: first block should be the earlier gate`);
    const second = runHook(t, CLOSED, {}, true);
    assertBlocked(second, `${name}: chain must still fire`);
    assert.match(second.stderr, /finish chain is incomplete/, `${name}: got ${second.stderr.slice(0, 300)}`);
    fs.rmSync(chainFileFor(t), { force: true });
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loop guard: blocks are capped per chain', skipNoRepoHook, () => {
  const dir = makeTmpDir('loopguard-cap');
  const t = writeTranscript(dir, [HOOK_EDIT, HOOK_RUN, GIT_PUSH, LINEAR_CLOSEOUT_DONE]);
  fs.writeFileSync(chainFileFor(t), 'A\nB\nC\nD\n');
  assertAllowed(runHook(t, CLOSED, {}, true), 'cap reached');
  fs.rmSync(chainFileFor(t), { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ship-check findings on the loop guard (2026-09-29).
test('loop guard: partial progress on the finish chain re-blocks until every step ran', skipNoRepoHook, () => {
  const dir = makeTmpDir('loopguard-partial');
  const t = writeTranscript(dir, [HOOK_EDIT, HOOK_RUN, GIT_PUSH, LINEAR_CLOSEOUT_DONE]);
  assertBlocked(runHook(t, CLOSED), 'nothing ran');
  // Ran only /ship-check, claims again in the same chain.
  writeTranscript(dir, [HOOK_EDIT, HOOK_RUN, GIT_PUSH, LINEAR_CLOSEOUT_DONE, SHIP_CHECK]);
  const r2 = runHook(t, CLOSED, {}, true);
  assertBlocked(r2, 'what-else and wrap-up still missing');
  assert.match(r2.stderr, /does not count\): \/what-else, then \/wrap-up/, `got: ${r2.stderr.slice(0, 300)}`);
  // Same missing set again: let through (no loop).
  assertAllowed(runHook(t, CLOSED, {}, true), 'same missing set is not re-blocked');
  fs.rmSync(dir, { recursive: true, force: true });
});

// second-opinion finding: the ledger was joined/split on ',' and NOCHAIN keys
// contain commas, so "review,what-else,wrap-up" read back as a set holding
// "NOCHAIN:review" and a review-only missing set was wrongly skipped.
test('loop guard: running /what-else + /wrap-up but no review still re-blocks for the review', skipNoRepoHook, () => {
  const dir = makeTmpDir('loopguard-review-last');
  const t = writeTranscript(dir, [HOOK_EDIT, HOOK_RUN, GIT_PUSH, LINEAR_CLOSEOUT_DONE]);
  assertBlocked(runHook(t, CLOSED), 'nothing ran');
  writeTranscript(dir, [HOOK_EDIT, HOOK_RUN, GIT_PUSH, LINEAR_CLOSEOUT_DONE, WHAT_ELSE, WRAP_UP]);
  const r2 = runHook(t, CLOSED, {}, true);
  assertBlocked(r2, 'review still missing');
  assert.match(r2.stderr, /does not count\): \/ship-check/, `got: ${r2.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loop guard: a ledger from an earlier chain is cleared at the next chain\'s first Stop', skipNoRepoHook, () => {
  const dir = makeTmpDir('loopguard-stale');
  const t = writeTranscript(dir, [HOOK_EDIT, HOOK_RUN, GIT_PUSH, LINEAR_CLOSEOUT_DONE]);
  fs.writeFileSync(chainFileFor(t), 'NOCHAIN:review,what-else,wrap-up\nA\nB\nC\n');
  // New chain, first Stop is clean for this hook (mid-work), another Stop hook blocks.
  assertAllowed(runHook(t, 'Working.\n\nKEEP OPEN — still editing.'), 'mid-work stop');
  // Next Stop arrives with stop_hook_active=true because the OTHER hook blocked.
  const r = runHook(t, CLOSED, {}, true);
  assertBlocked(r, 'stale ledger must not skip the chain gate');
  assert.match(r.stderr, /finish chain is incomplete/, `got: ${r.stderr.slice(0, 300)}`);
  assert.doesNotMatch(r.stderr, /No such file/, 'no stray shell noise in the block message');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loop guard: an unwritable ledger falls back to letting the Stop through (never loops)', skipNoRepoHook, () => {
  const dir = makeTmpDir('loopguard-unwritable');
  const t = writeTranscript(dir, [HOOK_EDIT, HOOK_RUN, GIT_PUSH, LINEAR_CLOSEOUT_DONE]);
  fs.rmSync(chainFileFor(t), { force: true });
  fs.mkdirSync(chainFileFor(t));   // a directory: appends fail
  assertAllowed(runHook(t, CLOSED, {}, true), 'cannot record, so must not block again');
  fs.rmSync(chainFileFor(t), { force: true, recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });
});


// ─── Open-work gate (OPENWORK, BRO-5040, 2026-10-11) ───────────────────────
// Owner: sessions closed on SAFE TO ARCHIVE after handing work to the board
// worker (queue weeks deep) or while a session they started was still
// working. Result shapes below are copied from real get_session output
// (status_bucket "SESSION_STATUS_BUCKET_WORKING", 2026-10-11).
const CHILD_ID = 'session_01Qf9FhcvFq7B4CnFGDoNvnn';
const childStatus = (bucket) => `{"ccr":{"id":"${CHILD_ID}","title":"BRO-5033: fix","session_status":"SESSION_STATUS_RUNNING","status_bucket":"SESSION_STATUS_BUCKET_${bucket}"}}`;
const CREATE_CHILD = toolUse('mcp__claude-code-remote__create_session', { title: 'BRO-5033: fix workflow checks', prompt: 'Work BRO-5033 to a landed fix' },
  `{"ccr":{"id":"${CHILD_ID}","title":"BRO-5033: fix workflow checks","session_status":"SESSION_STATUS_RUNNING"}}`);
const GET_CHILD = (bucket) => toolUse('mcp__claude-code-remote__get_session', { session_id: CHILD_ID }, childStatus(bucket));
const ARCHIVE_CHILD = toolUse('mcp__claude-code-remote__archive_session', { session_id: CHILD_ID }, '{"ccr":{"id":"' + CHILD_ID + '","session_status":"SESSION_STATUS_ARCHIVED"}}');

function assertOpenwork(r, message) {
  assertBlocked(r, message);
  assert.match(r.stderr, /hands work to the board worker/i, `expected the OPENWORK message, got: ${r.stderr.slice(0, 400)}`);
}

// BRO-5881 (owner 2026-10-22): a started session owns its work and lands it
// itself, so it no longer blocks SAFE TO ARCHIVE, whatever its last status.
test('OPENWORK: a started session that is still working does not block SAFE TO ARCHIVE (BRO-5881)', skipNoRepoHook, () => {
  const dir = makeTmpDir('openwork-child');
  assertAllowed(runHook(writeTranscript(dir, [CREATE_CHILD, LINEAR_CLOSEOUT_DONE]), SAFE_MSG), 'never checked');
  for (const b of ['WORKING', 'BLOCKED', 'FAILED']) {
    assertAllowed(runHook(writeTranscript(dir, [CREATE_CHILD, GET_CHILD(b), LINEAR_CLOSEOUT_DONE]), SAFE_MSG), `${b}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('OPENWORK: handing work to the worker queue + SAFE TO ARCHIVE → BLOCKED; BACKLOG-OK passes; NOT SAFE passes', skipNoRepoHook, () => {
  const dir = makeTmpDir('openwork-handoff');
  const t = writeTranscript(dir, [LINEAR_CLOSEOUT_DONE]);
  for (const line of [
    'A card for this was already open, so I queued it for an automatic worker.',
    'The cloud worker will pick it up on its own.',
    'I filed it as a START-NOW card.',
    'The board worker should take it within a day.',
    'Left the rest to the cloud worker.',
  ]) {
    assertOpenwork(runHook(t, `${line}\n\nSAFE TO ARCHIVE`), line);
  }
  assertAllowed(runHook(t, 'Filed a low-priority card for the typo; the board worker can take it.\nBACKLOG-OK: cosmetic typo on an archive page, fine to wait weeks\n\nSAFE TO ARCHIVE'), 'BACKLOG-OK is the escape for work that can wait');
  assertAllowed(runHook(t, 'The automatic worker has the card.\n\nKEEP OPEN — the fix is not done yet.'), 'KEEP OPEN is honest');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('OPENWORK false-positive guards: ordinary closings, and phrases inside code', skipNoRepoHook, () => {
  const dir = makeTmpDir('openwork-fp');
  const t = writeTranscript(dir, [LINEAR_CLOSEOUT_DONE]);
  for (const msg of [
    'Fixed and landed; the site picks it up on the next rebuild.\n\nSAFE TO ARCHIVE',
    'The poller will pick up reviews tonight; nothing for you to do.\n\nSAFE TO ARCHIVE',
    'Updated `docs/cloud-routines/board-workers.md` wording.\n\nSAFE TO ARCHIVE',
    'Ran:\n```\nnode scripts/cloud-worker-pick.js  # START-NOW cards first\n```\nAll landed.\n\nSAFE TO ARCHIVE',
    "Fixed the cloud worker's START-NOW ordering; landed and verified on main.\n\nSAFE TO ARCHIVE",
    'I did not hand this to the board worker; it is landed and verified.\n\nSAFE TO ARCHIVE',
    'Explained the escape: add `BACKLOG-OK: <why>` only for real backlog. Everything landed.\n\nSAFE TO ARCHIVE',
  ]) {
    assertAllowed(runHook(t, msg), msg.slice(0, 60));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT matches the lowercase server spelling too (BRO-5040)', skipNoRepoHook, () => {
  const dir = makeTmpDir('inflight-lowercase');
  const lower = toolUse('mcp__claude-code-remote__send_later', { delay_minutes: 60, message: 'check' }, `{"fire_at":"${FAR}","trigger_id":"trig_01LOWER"}`);
  assertInflight(runHook(writeTranscript(dir, [lower, LINEAR_CLOSEOUT_DONE]), SAFE_MSG), 'mcp__claude-code-remote__send_later is a live check-in');
  const del = toolUse('mcp__claude-code-remote__delete_trigger', { trigger_id: 'trig_01LOWER' }, '{"trigger":{"id":"trig_01LOWER"}}');
  assertAllowed(runHook(writeTranscript(dir, [lower, del, LINEAR_CLOSEOUT_DONE]), SAFE_MSG), 'and its delete ends it');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── BRO-5068: project commands that did not load ──────────────────────────
// Real incident (session_01FWSvQMmC8bfhWqhXpn1z2G, 2026-10-11): a session
// started with create_session came up without the repo's .claude/commands.
// Skill('ship-check') failed "Unknown skill", and the session closed SAFE TO
// EXIT with NO-WHAT-ELSE/NO-WRAP-UP "commands aren't loaded". The failed Skill
// call used to count as a run.
const unknownSkill = (sk) => ({ ...toolUse('Skill', { skill: sk }, `<tool_use_error>Unknown skill: ${sk}</tool_use_error>`), _isError: true });
const readCmd = (sk) => toolUse('Read', { file_path: `/home/user/Broadwayscore/.claude/worktrees/bro-5065/.claude/commands/${sk}.md` }, '# instructions');

test('BRO-5068: failed Skill calls (Unknown skill) do not count as the review, /what-else or /wrap-up → BLOCKED', skipNoRepoHook, () => {
  const r = chain('cmd-unknown', [HOOK_EDIT, HOOK_RUN, unknownSkill('ship-check'), unknownSkill('what-else'), unknownSkill('wrap-up'), GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED);
  assertBlocked(r, 'a failed skill call is not a run');
  assert.match(r.stderr, /finish chain is incomplete.*ship-check.*what-else.*wrap-up/s, `got: ${r.stderr.slice(0, 400)}`);
  assert.match(r.stderr, /Read \.claude\/commands\/<name>\.md/, 'the block names the by-hand fallback');
});

test('BRO-5068: after Unknown skill, reading the command file and following it counts → ALLOWED', skipNoRepoHook, () => {
  const catWrap = toolUse('Bash', { command: 'cat /home/user/Broadwayscore/.claude/commands/wrap-up.md' }, '# wrap-up');
  const r = chain('cmd-fallback', [HOOK_EDIT, HOOK_RUN, unknownSkill('ship-check'), readCmd('ship-check'),
    unknownSkill('what-else'), readCmd('what-else'), unknownSkill('wrap-up'), catWrap, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED);
  assertAllowed(r, 'the by-hand fallback runs each step');
});

test('BRO-5068: reading the file WITHOUT a failed Skill call first does not count (use the skill when it exists)', skipNoRepoHook, () => {
  const r = chain('cmd-read-only', [HOOK_EDIT, HOOK_RUN, readCmd('ship-check'), readCmd('what-else'), readCmd('wrap-up'), GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED);
  assertBlocked(r, 'reading alone is not running the skill');
});

test('BRO-5068: reading a DIFFERENT command after a failure does not count for the failed one', skipNoRepoHook, () => {
  const r = chain('cmd-wrong-file', [HOOK_EDIT, HOOK_RUN, unknownSkill('ship-check'), readCmd('second-opinion'), WHAT_ELSE, WRAP_UP, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED);
  assertBlocked(r, 'second-opinion.md is not ship-check.md');
  assert.match(r.stderr, /ship-check/);
});

test('BRO-5068: "commands aren\'t loaded" is not a bypass reason; an honest reason still is', skipNoRepoHook, () => {
  const calls = [HOOK_EDIT, HOOK_RUN, SHIP_CHECK, unknownSkill('what-else'), unknownSkill('wrap-up'), GIT_PUSH, LINEAR_CLOSEOUT_DONE];
  const excuse = "Done.\nNO-WHAT-ELSE: the project's /what-else and /wrap-up commands aren't loaded in this cloud session.\nNO-WRAP-UP: same reason, the wrap-up command is not available here.\n\nSAFE TO ARCHIVE";
  assertBlocked(chain('cmd-excuse', calls, excuse), 'the real incident wording');
  const honest = 'Done.\nNO-WHAT-ELSE: docs-only follow-up to a change already what-else checked today\nNO-WRAP-UP: Linear API not available, outcome posted on the PR instead\n\nSAFE TO ARCHIVE';
  assertAllowed(chain('cmd-honest', calls, honest), 'an unrelated "not available" reason is still a reason');
});

test('BRO-5068: a real Skill call still counts (unchanged)', skipNoRepoHook, () => {
  assertAllowed(chain('cmd-real', [HOOK_EDIT, HOOK_RUN, SHIP_CHECK, WHAT_ELSE, WRAP_UP, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED), 'real runs');
});

test('BRO-5068: honest reasons that say "missing"/"unknown" pass; reworded "did not load" excuses do not', skipNoRepoHook, () => {
  const calls = [HOOK_EDIT, HOOK_RUN, SHIP_CHECK, unknownSkill('what-else'), unknownSkill('wrap-up'), GIT_PUSH, LINEAR_CLOSEOUT_DONE];
  const honest = 'Done.\nNO-WHAT-ELSE: what-else already ran on this branch today; nothing missing\nNO-WRAP-UP: doc-only commit, wrap-up outcome posted earlier, no unknowns\n\nSAFE TO ARCHIVE';
  assertAllowed(chain('cmd-honest2', calls, honest), 'missing/unknown in an honest reason');
  // BRO-5221 review: honest reasons near "command"/"skill" with not found/present/installed.
  for (const ok of ['the command not present in diff', 'ship-check ran in parent session; secrets not found in diff', 'the hook command is not installed on CI']) {
    assertAllowed(chain('cmd-honest3', calls, `Done.\nNO-WHAT-ELSE: ${ok}\nNO-WRAP-UP: ${ok}\n\nSAFE TO ARCHIVE`), ok);
  }
  for (const ex of ['the slash commands did not load here', 'skills unavailable in this session', 'wrap-up isnt available', 'no such skill: what-else',
    // BRO-5221 incident wording (session_01SBtqUQy2vUqYa7GK6mAnCU) and near variants.
    "the /what-else and /wrap-up commands aren't loadable as skills in this cloud session",
    'the skill could not be loaded', 'wrap-up command is not loadable here']) {
    const msg = `Done.\nNO-WHAT-ELSE: ${ex}\nNO-WRAP-UP: ${ex}\n\nSAFE TO ARCHIVE`;
    assertBlocked(chain('cmd-excuse2', calls, msg), ex);
  }
});

test('BRO-5068: a fallback Read that itself failed does not count', skipNoRepoHook, () => {
  const badRead = { ...readCmd('ship-check'), _result: '<tool_use_error>File does not exist.</tool_use_error>', _isError: true };
  assertBlocked(chain('cmd-badread', [HOOK_EDIT, HOOK_RUN, unknownSkill('ship-check'), badRead, WHAT_ELSE, WRAP_UP, GIT_PUSH, LINEAR_CLOSEOUT_DONE], CLOSED), 'an errored read ran nothing');
});

// ─── Loose-ends gate (LOOSEENDS, BRO-5881, 2026-10-22) ──────────────────────
// Owner: SAFE TO ARCHIVE claimed while the same message still had an offer, a
// hidden owner call, or unfinished/uncarded work. Closings below are real
// ones from 2026-10-21 sessions, lightly trimmed.
const LE_ON = { LOOSEENDS_GATE_DISABLE: '0' };
function assertLoose(r, message) {
  assertBlocked(r, message);
  assert.match(r.stderr, /loose end/i, `expected the LOOSEENDS message, got: ${r.stderr.slice(0, 400)}`);
}

test('LOOSEENDS: real loose-end closings + SAFE TO ARCHIVE → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('loose-block');
  const t = writeTranscript(dir, [LINEAR_CLOSEOUT_DONE]);
  for (const body of [
    'Turned the poller alert off. Tell me if you want even that one turned off.',
    'Want me to also clean up the old rows?',
    'BRO-5582 is paused because it needs an owner call. Nothing is needed from you.',
    'The change is committed locally but not pushed or landed.',
    'Production verified: partly. I could not confirm that the final follow-up commit has deployed.',
    'Two helper scripts still sort pushes by path. I left it unfiled because the mismatch is rare.',
    'The daily collection runs by itself, and I\'ll recheck it on Oct 22.',
    'Checked only with simulated inputs. Both will happen naturally the next time it runs.',
    'BRO-5003 is paused, waiting on the checking session\'s approval.',
    'The topic-pages session left three minor review notes for later.',
    'One thing I haven\'t seen with my own eyes: the caption on a real live show page.',
    'I didn\'t run the repo\'s /what-else and /wrap-up finishing steps. I closed the card by hand.',
    'I left two stale branches on GitHub; deleting them is your call.',
    'I didn\u2019t test on mobile.',
    'The change hasn\u2019t been pushed and I couldn\u2019t confirm the deploy.',
    'I didn\'t verify the last deploy, and I haven\u2019t seen the live page.',
    '```\n━━━ TESTED ━━━\nProduction verified: partly. I could not confirm the last commit deployed.\n━━━━━━\n```\nThe rewrite works.',
  ]) {
    assertLoose(runHook(t, `${body}\n\nNothing needed from you.\n\nSAFE TO ARCHIVE`, LE_ON), body);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('LOOSEENDS: the honest rewrites pass (NOT SAFE, BACKLOG-OK for deferrals) but BACKLOG-OK never excuses an offer', skipNoRepoHook, () => {
  const dir = makeTmpDir('loose-allow');
  const t = writeTranscript(dir, [LINEAR_CLOSEOUT_DONE]);
  assertAllowed(runHook(t, 'Want me to also clean up the old rows?\n\nKEEP OPEN — waiting on your answer.', LE_ON), 'NOT SAFE is not gated by LOOSEENDS');
  assertAllowed(runHook(t, 'Left three minor review notes for later on their own card.\nBACKLOG-OK: cosmetic wording, fine to wait\n\nSAFE TO ARCHIVE', LE_ON), 'carded deferral');
  assertLoose(runHook(t, 'Want me to also clean up the old rows?\nBACKLOG-OK: cosmetic\n\nSAFE TO ARCHIVE', LE_ON), 'an offer is never backlog');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('LOOSEENDS false-positive guards: ordinary finished closings', skipNoRepoHook, () => {
  const dir = makeTmpDir('loose-fp');
  const t = writeTranscript(dir, [LINEAR_CLOSEOUT_DONE]);
  for (const msg of [
    'The fix is live on the site.\n\nStill running: nothing.\n\nYou need to: nothing.\n\nSAFE TO ARCHIVE',
    'Fixed the scorer and landed it; checked the live page.\n\nNothing is still running.\n\nNothing needed from you.\n\nSAFE TO ARCHIVE — landed and verified.',
    'Ran:\n```\nnode x.js --check  # I\'ll check later\n```\nAll landed.\n\nSAFE TO ARCHIVE',
    '> Want me to keep going?\nYou asked that earlier; it is done now and landed.\n\nSAFE TO ARCHIVE',
    'Saved the report; the old rows were fixed and verified on main.\n\nSAFE TO ARCHIVE',
    'The card rechecks real poller runs on 10/22 by itself.\n\nSAFE TO ARCHIVE',
    'I haven\'t seen any errors in the logs and I didn\'t run into issues. Nothing here is your call.\n\nSAFE TO ARCHIVE',
    'I didn\'t see errors in the logs, and I didn\'t see a regression.\n\nSAFE TO ARCHIVE',
  ]) {
    assertAllowed(runHook(t, msg, LE_ON), msg.slice(0, 60));
  }
  assertAllowed(runHook(t, 'Want me to do more?\n\nSAFE TO ARCHIVE', { ...LE_ON, LOOSEENDS_GATE_DISABLE: '1' }), 'kill switch');
  assertAllowed(runHook(t, 'Want me to do more?\nNO-VERIFY: owner asked for a menu of options\n\nSAFE TO ARCHIVE', LE_ON), 'bypass');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── Wake gate (WAKELESS, BRO-5881, 2026-10-22) ─────────────────────────────
// Owner: "KEEP OPEN — waiting on X" with nothing armed to wake the
// session; found idle 10-19 hours later. Real closing (session 014vS4Wn).
const WK_ON = { WAKELESS_GATE_DISABLE: '0' };
const STALE = 'The second landing is still running. I\'ll check it at 14:56 and wrap up if it passes.\n\nStill running: the second landing.\n\nYou need to: nothing.\n\nKEEP OPEN, the landing isn\'t confirmed on main.';
function assertWakeless(r, message) {
  assertBlocked(r, message);
  assert.match(r.stderr, /nothing will wake it/i, `expected the WAKELESS message, got: ${r.stderr.slice(0, 400)}`);
}
const BG_WAIT = toolUse('Bash', { command: 'node scripts/lib/wait-for-land.js land/x 60 --prod', run_in_background: true, description: 'wait for land' },
  'Command running in background with ID: b1e9y745t. Output is being written to: /tmp/x.output.');
const BG_DONE = notice('<task-notification>\n<task-id>b1e9y745t</task-id>\n<status>completed</status>\n</task-notification>');

test('WAKELESS: incident replay — NOT SAFE, waiting, nothing armed → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('wake-stale');
  assertWakeless(runHook(writeTranscript(dir, [GIT_PUSH]), STALE, WK_ON), 'the 11-hour idle session');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WAKELESS: each real wake passes — background Bash, Monitor, background Agent, started session, PR subscription, owner-asked send_later', skipNoRepoHook, () => {
  const dir = makeTmpDir('wake-armed');
  const monitor = toolUse('Monitor', { command: 'until gh-free-check; do sleep 60; done', description: 'land run' }, 'Monitor started with ID: m0n1t0r9.');
  const agent = toolUse('Agent', { description: 'scan', prompt: 'x', run_in_background: true }, 'Async agent launched successfully.\nagentId: a1b2c3d4e5f6');
  const sub = toolUse('mcp__claude-code-remote__subscribe_pr_activity', { owner: 'thomaspryor', repo: 'Broadwayscore', pullNumber: 42 }, 'subscribed');
  const later = toolUse('mcp__claude-code-remote__send_later', { delay_minutes: 60, message: 'check', initiation: 'human_request' }, `{"fire_at":"${FAR}","trigger_id":"trig_01OWNER"}`);
  for (const [label, calls] of [['bg bash', [BG_WAIT]], ['monitor', [monitor]], ['agent', [agent]],
    ['child', [CREATE_CHILD, GET_CHILD('WORKING')]], ['pr', [sub]], ['send_later', [later]]]) {
    assertAllowed(runHook(writeTranscript(dir, [GIT_PUSH, ...calls]), STALE, WK_ON), label);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WAKELESS: a wake that already finished is not a wake', skipNoRepoHook, () => {
  const dir = makeTmpDir('wake-done');
  assertWakeless(runHook(writeTranscript(dir, [GIT_PUSH, BG_WAIT, BG_DONE]), STALE, WK_ON), 'background wait already exited');
  assertWakeless(runHook(writeTranscript(dir, [GIT_PUSH, CREATE_CHILD, GET_CHILD('COMPLETED')]), STALE, WK_ON), 'child already finished');
  const denied = toolUse('mcp__claude-code-remote__send_later', { delay_minutes: 60, message: 'check' }, 'PreToolUse: Blocked: send_later and create_trigger put an approval prompt');
  assertWakeless(runHook(writeTranscript(dir, [GIT_PUSH, denied]), STALE, WK_ON), 'a denied send_later arms nothing');
  // A stop-hook block between the wait and the closing does not hide the wait.
  const fb = { _notice: 'Stop hook feedback: something else first', _isMeta: true }; // real Stop feedback is isMeta
  assertAllowed(runHook(writeTranscript(dir, [GIT_PUSH, BG_WAIT, fb]), STALE, WK_ON), 'wait survives a re-fired Stop');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WAKELESS: waiting on the owner needs no wake; bypass and kill switch', skipNoRepoHook, () => {
  const dir = makeTmpDir('wake-owner');
  const t = writeTranscript(dir, [GIT_PUSH]);
  assertAllowed(runHook(t, 'Two ways to go.\n\nDECISION NEEDED: keep or drop the old page?\nWhy this is your call: taste.\n\nACTION NEEDED FROM YOU — waiting on your decision.', WK_ON), 'decision');
  assertAllowed(runHook(t, 'You need to: paste the new password into App Store Connect.\n\nACTION NEEDED FROM YOU — paste the password.', WK_ON), 'owner action');
  assertWakeless(runHook(t, 'You need to: nothing.\n\nKEEP OPEN — CI still running.', WK_ON), '"nothing" is not an owner action');
  assertAllowed(runHook(t, STALE, { WAKELESS_GATE_DISABLE: '1' }), 'kill switch');
  assertAllowed(runHook(t, STALE.replace('KEEP OPEN', 'NO-VERIFY: container restarting\n\nKEEP OPEN'), WK_ON), 'bypass');
  assert.doesNotMatch(runHook(t, 'Done and landed.\n\nSAFE TO ARCHIVE', WK_ON).stderr, /nothing will wake it/i, 'SAFE is not this gate');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── Child-wait gate (CHILDWAIT, BRO-6264) ───────────────────────────────────
const CW_ON = { CHILDWAIT_GATE_DISABLE: '0' };
const CW_CHILD = { userText: 'BRO-6154: fix probe\nBUDGET: 6h\n' };
const CW_CLOSE = 'The probe workflow was started.\n\nStill running: the test run is in progress.\n\nYou need to: nothing.\n\nKEEP OPEN — the test run is in progress; once it finishes I extend the fix.';
const CW_DISPATCH = toolUse('Bash', { command: 'gh workflow run we-historical-tr-probe.yml' });
function assertChildWait(r, message) {
  assertBlocked(r, message);
  assert.match(r.stderr, /child worker session/i, `expected the CHILDWAIT message, got: ${r.stderr.slice(0, 400)}`);
}
test('CHILDWAIT: BRO-6154 replay — child fires a run after an old background wait, ends KEEP OPEN → BLOCKED', skipNoRepoHook, () => {
  const dir = makeTmpDir('childwait');
  assertChildWait(runHook(writeTranscript(dir, [BG_WAIT, CW_DISPATCH], CW_CHILD), CW_CLOSE, CW_ON), 'stale bg wait before dispatch');
  assertAllowed(runHook(writeTranscript(dir, [CW_DISPATCH, BG_WAIT], CW_CHILD), CW_CLOSE, CW_ON), 'bg poll armed after the dispatch');
  assertAllowed(runHook(writeTranscript(dir, [BG_WAIT, CW_DISPATCH]), CW_CLOSE, CW_ON), 'not a child (human session)');
  assertAllowed(runHook(writeTranscript(dir, [BG_WAIT, CW_DISPATCH], CW_CHILD), CW_CLOSE, { CHILDWAIT_GATE_DISABLE: '1' }), 'kill switch');
  assertAllowed(runHook(writeTranscript(dir, [BG_WAIT, CW_DISPATCH], CW_CHILD), 'NO-VERIFY: x\n\n' + CW_CLOSE, CW_ON), 'bypass');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('LOOSEENDS false-positive guards from the ship-check review: negations and descriptions', skipNoRepoHook, () => {
  const dir = makeTmpDir('loose-fp2');
  const t = writeTranscript(dir, [LINEAR_CLOSEOUT_DONE]);
  for (const body of [
    'Nothing here needs an owner decision.',
    'Landed with zero unresolved review threads. Nothing unresolved.',
    'This does not fix the iOS app, which never had the bug.',
    'The stale branch was deleted; nothing else to push.',
    'No longer waiting on your answer: you replied and it is done.',
  ]) {
    assertAllowed(runHook(t, `${body}\n\nSAFE TO ARCHIVE`, LE_ON), body);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WAKELESS: a bold or bulleted DECISION NEEDED counts as waiting on the owner', skipNoRepoHook, () => {
  const dir = makeTmpDir('wake-bold');
  const t = writeTranscript(dir, [GIT_PUSH]);
  assertAllowed(runHook(t, '**DECISION NEEDED:** keep or drop the page?\n\nACTION NEEDED FROM YOU — waiting on your decision.', WK_ON), 'bold');
  assertAllowed(runHook(t, '- DECISION NEEDED: keep or drop the page?\n\nACTION NEEDED FROM YOU — waiting on your decision.', WK_ON), 'bulleted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WAKELESS: a background wait from before the owner\'s latest message does not count', skipNoRepoHook, () => {
  const dir = makeTmpDir('wake-old');
  const owner = { _notice: 'is it done yet?', _extra: { origin: { kind: 'human' } } };
  assertWakeless(runHook(writeTranscript(dir, [GIT_PUSH, BG_WAIT, owner]), STALE, WK_ON), 'stale wait from an earlier turn');
  assertAllowed(runHook(writeTranscript(dir, [GIT_PUSH, owner, BG_WAIT]), STALE, WK_ON), 'wait started after it');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('INFLIGHT/LOOSEENDS: a TESTED status box after the closing line does not hide the line', skipNoRepoHook, () => {
  const dir = makeTmpDir('box-after');
  const agent = toolUse('Agent', { description: 'scan', prompt: 'x', run_in_background: true }, 'Async agent launched successfully.\nagentId: a1b2c3d4e5f6');
  const msg = 'All landed.\n\nSAFE TO ARCHIVE\n```\n━━━ TESTED ━━━\nProduction verified: yes\n━━━━━━\n```';
  assertBlocked(runHook(writeTranscript(dir, [agent, LINEAR_CLOSEOUT_DONE]), msg), 'the live agent still blocks SAFE');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── Clear-closing gate (CLEARCLOSE, BRO-5910, 2026-10-22) ──────────────────
// Owner: sessions must be extremely clear at the end of their messages.
// Closings below are real 2026-10-21 endings (trimmed) and their rewrites.
const CC_ON = { CLEARCLOSE_GATE_DISABLE: '0' };
function assertUnclear(r, message, what) {
  assertBlocked(r, message);
  assert.match(r.stderr, /closing block is missing/i, `expected the CLEARCLOSE message, got: ${r.stderr.slice(0, 400)}`);
  if (what) assert.match(r.stderr, what);
}
const CLEAR = 'The fix is live on the site.\n\nNothing is still running.\n\nNothing needed from you.\n\nSAFE TO ARCHIVE';

test('CLEARCLOSE: real unclear endings → BLOCKED, naming what is missing', skipNoRepoHook, () => {
  const dir = makeTmpDir('cc-block');
  const t = writeTranscript(dir, [GIT_PUSH, LINEAR_CLOSEOUT_DONE]);
  assertUnclear(runHook(t, 'The ballet guard is on main. I\'m waiting for that to land.\n\nNothing needed from you.\n\nKEEP OPEN', CC_ON), 'bare NOT SAFE', /Still running|reason on the KEEP OPEN/);
  assertUnclear(runHook(t, 'Shipped.\n\nYou need to: nothing.\n\nSAFE TO ARCHIVE', CC_ON), 'no still-running line', /Still running/);
  assertUnclear(runHook(t, 'Shipped.\n\nNothing is still running.\n\nSAFE TO ARCHIVE', CC_ON), 'no you-need line', /You need to/);
  assertUnclear(runHook(t, 'Shipped.\n\nNothing is still running.\n\nNothing needed from you; closed BRO-5717 (commit e66ac2363).\n\nSAFE TO ARCHIVE', CC_ON), 'ids in the last lines', /BRO-5717/);
  assertUnclear(runHook(t, 'Shipped.\n\nNothing is still running.\n\nNothing needed from you.\n\nSAFE TO ARCHIVE — see `scripts/lib/x.js`', CC_ON), 'code on the status line');
  assertUnclear(runHook(t, 'Shipped.\n\nNothing is still running.\nNOTE: closed BRO-1 in e66ac23.\nNothing needed from you.\n\nSAFE TO ARCHIVE', CC_ON), 'a NOTE: line is prose, not a gate token', /BRO-1/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLEARCLOSE: clear endings pass, including technical detail higher up and a NOT SAFE with its reason', skipNoRepoHook, () => {
  const dir = makeTmpDir('cc-allow');
  const t = writeTranscript(dir, [GIT_PUSH, LINEAR_CLOSEOUT_DONE]);
  assertAllowed(runHook(t, CLEAR, CC_ON), 'canonical');
  assertAllowed(runHook(t, 'Fixed BRO-5717 in scripts/lib/x.js (commit e66ac2363).\n\nThe early-date audit now counts only reachable reviews.\n\nNothing is still running.\n\nYou need to: nothing.\n\nSAFE TO ARCHIVE', CC_ON), 'ids higher up are fine');
  assertAllowed(runHook(t, 'The cleanup is landing.\n\nStill running: the landing; a background wait wakes me when it finishes.\n\nNothing needed from you.\n\nKEEP OPEN — waiting for the cleanup to land, then I run it and check the shows.', CC_ON), 'NOT SAFE with reason');
  assertAllowed(runHook(t, '**Still running:** nothing.\n\n**You need to:** nothing.\n\nSAFE TO ARCHIVE', CC_ON), 'bold labels');
  assertAllowed(runHook(t, 'The show page now lists the new critics: https://broadwayscorecard.com/shows/hamilton.html\n\nNothing is still running.\n\nNothing needed from you.\n\nSAFE TO ARCHIVE', CC_ON), 'one URL with an extension');
  assertAllowed(runHook(t, 'The new score is 85/90.5 for critics, up from 1.5/2.0 stars.\n\nNothing is still running.\n\nNothing needed from you.\n\nSAFE TO ARCHIVE', CC_ON), 'score ratios are not paths');
  assertAllowed(runHook(t, 'Two ways to go.\n\nDECISION NEEDED: keep or drop the old page?\nWhy this is your call: taste.\nOption A — keep: familiar / clutter\nOption B — drop: cleaner / loses links\nMy recommendation: B because nobody visits it.\nDefault: I keep it.\n\nNothing is still running.\n\nYou need to: answer the decision above.\n\nACTION NEEDED FROM YOU — answer the decision above', CC_ON), 'DECISION NEEDED template');
  assertAllowed(runHook(t, 'Shipped.\n\nNothing is still running.\n\nNothing needed from you.\nNO-SHIP-CHECK: docs-only change, no code to review in BRO-1\n\nSAFE TO ARCHIVE', CC_ON), 'gate token lines are skipped');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLEARCLOSE: only after real work; bypass and kill switch', skipNoRepoHook, () => {
  const dir = makeTmpDir('cc-scope');
  const idle = writeTranscript(dir, [], { card: false });
  assertAllowed(runHook(idle, 'Here is the answer.\n\nSAFE TO ARCHIVE', CC_ON), 'a read-only turn is not gated');
  const t = writeTranscript(dir, [GIT_PUSH, LINEAR_CLOSEOUT_DONE]);
  assertAllowed(runHook(t, 'Shipped.\n\nSAFE TO ARCHIVE', { CLEARCLOSE_GATE_DISABLE: '1' }), 'kill switch');
  assertAllowed(runHook(t, 'Shipped.\nNO-VERIFY: owner asked for a one-line reply\n\nSAFE TO ARCHIVE', CC_ON), 'bypass');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── BRO-6020: three closing verdicts ───────────────────────────────────────
// Owner, 2026-10-22: SAFE TO EXIT could not say "you can walk away, but don't
// archive". The closing line is now SAFE TO ARCHIVE / KEEP OPEN / ACTION
// NEEDED FROM YOU. Legacy lines are asked about once (LEGACYSTATUS) and then
// keep counting as their aliases, so no gate goes quiet.
function assertLegacy(r, message) {
  assertBlocked(r, message);
  assert.match(r.stderr, /were replaced/i, `expected the LEGACYSTATUS message, got: ${r.stderr.slice(0, 400)}`);
}
function assertMismatch(r, message) {
  assertBlocked(r, message);
  assert.match(r.stderr, /verdict doesn't match/i, `expected the VERDICTMISMATCH message, got: ${r.stderr.slice(0, 400)}`);
}

test('BRO-6020 LEGACYSTATUS: SAFE TO EXIT / NOT SAFE TO EXIT are asked about once, bold included', skipNoRepoHook, () => {
  const dir = makeTmpDir('legacy-status');
  const t = writeTranscript(dir, [GIT_PUSH, LINEAR_CLOSEOUT_DONE]);
  assertLegacy(runHook(t, 'Pushed, card closed.\n\nSAFE TO EXIT — all done.'), 'legacy SAFE');
  fs.rmSync(chainFileFor(t), { force: true });
  assertLegacy(runHook(t, 'Pushed.\n\nNOT SAFE TO EXIT — CI still running.'), 'legacy NOT SAFE');
  fs.rmSync(chainFileFor(t), { force: true });
  assertLegacy(runHook(t, 'Pushed.\n\n**SAFE TO EXIT** — all done.'), 'bold legacy');
  fs.rmSync(chainFileFor(t), { force: true });
  assertAllowed(runHook(t, 'Pushed, card closed.\n\n**SAFE TO ARCHIVE** — all done.'), 'bold new verdict');
  assertAllowed(runHook(t, 'Pushed.\nNO-VERIFY: replaying an old transcript\n\nSAFE TO EXIT — all done.'), 'bypass');
  fs.rmSync(chainFileFor(t), { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRO-6020 aliases: after LEGACYSTATUS fired, a legacy SAFE TO EXIT is still held to the SAFE gates', skipNoRepoHook, () => {
  const dir = makeTmpDir('legacy-alias');
  const t = writeTranscript(dir, [GIT_PUSH, LINEAR_CLOSEOUT_DONE]);
  const msg = 'Pushed.\n\nWant me to also clean up the old rows?\n\nSAFE TO EXIT — done.';
  assertLegacy(runHook(t, msg, LE_ON), 'first Stop: legacy line');
  const r2 = runHook(t, msg, LE_ON, true);
  assertBlocked(r2, 'LOOSEENDS still fires on the legacy alias');
  assert.match(r2.stderr, /loose end/i, `got: ${r2.stderr.slice(0, 300)}`);
  fs.rmSync(chainFileFor(t), { force: true });
  const stale = STALE.replace('KEEP OPEN', 'NOT SAFE TO EXIT');
  assertLegacy(runHook(t, stale, WK_ON), 'first Stop: legacy NOT SAFE');
  assertWakeless(runHook(t, stale, WK_ON, true), 'WAKELESS still fires on legacy NOT SAFE');
  fs.rmSync(chainFileFor(t), { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRO-6020 VERDICTMISMATCH: the verdict must match who acts next', skipNoRepoHook, () => {
  const dir = makeTmpDir('verdict-mismatch');
  const t = writeTranscript(dir, [GIT_PUSH, LINEAR_CLOSEOUT_DONE]);
  assertMismatch(runHook(t, 'DECISION NEEDED: keep or drop the page?\n\nKEEP OPEN — waiting on your decision.'), 'decision + KEEP OPEN');
  fs.rmSync(chainFileFor(t), { force: true });
  assertMismatch(runHook(t, 'You need to: paste the password into App Store Connect.\n\nKEEP OPEN — waiting on the password.'), 'owner action + KEEP OPEN');
  fs.rmSync(chainFileFor(t), { force: true });
  assertMismatch(runHook(t, 'Nothing is still running.\n\nNothing needed from you.\n\nACTION NEEDED FROM YOU — have a look.'), 'ACTION NEEDED with nothing asked');
  fs.rmSync(chainFileFor(t), { force: true });
  assertAllowed(runHook(t, 'You need to: paste the password into App Store Connect.\n\nACTION NEEDED FROM YOU — paste the password.'), 'owner action + ACTION NEEDED');
  assertAllowed(runHook(t, 'You need to: nothing.\n\nKEEP OPEN — CI still running on the landing.'), '"nothing" + KEEP OPEN');
  assertAllowed(runHook(t, 'DECISION NEEDED: keep or drop the page?\n\nACTION NEEDED FROM YOU — answer the decision above.'), 'decision + ACTION NEEDED');
  fs.rmSync(chainFileFor(t), { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRO-6020 LOOSEENDS: SAFE TO ARCHIVE while still waiting on another session or a run → BLOCKED; negated and past waits pass', skipNoRepoHook, () => {
  const dir = makeTmpDir('archive-waiting');
  const t = writeTranscript(dir, [GIT_PUSH, LINEAR_CLOSEOUT_DONE]);
  for (const body of [
    'The fix is started in its own session; I am waiting on its result to update the page.',
    'Still waiting for the land run.',
    'I will update the docs once the other session finishes.',
    'Card closed. Waiting on the worker session to report back.',
  ]) {
    assertLoose(runHook(t, `${body}\n\nSAFE TO ARCHIVE — done.`, LE_ON), body);
    fs.rmSync(chainFileFor(t), { force: true });
  }
  for (const body of [
    'Nothing here is waiting on anything.',
    'I was waiting for CI and it passed; the change is live.',
    'The started session owns the rest and lands it itself; this session is not waiting on it.',
  ]) {
    assertAllowed(runHook(t, `${body}\n\nSAFE TO ARCHIVE — done.`, LE_ON), body);
  }
  assertAllowed(runHook(t, 'Still waiting for the land run.\n\nKEEP OPEN — waiting for the land run.', LE_ON), 'KEEP OPEN is not LOOSEENDS');
  fs.rmSync(chainFileFor(t), { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRO-6020 CLEARCLOSE: KEEP OPEN and ACTION NEEDED need a reason; WAKELESS skips ACTION NEEDED', skipNoRepoHook, () => {
  const dir = makeTmpDir('cc-verdicts');
  const t = writeTranscript(dir, [GIT_PUSH, LINEAR_CLOSEOUT_DONE]);
  assertUnclear(runHook(t, 'Waiting on the land.\n\nStill running: the landing.\n\nNothing needed from you.\n\nKEEP OPEN', CC_ON), 'bare KEEP OPEN', /reason on the KEEP OPEN/);
  fs.rmSync(chainFileFor(t), { force: true });
  assertUnclear(runHook(t, 'DECISION NEEDED: keep or drop?\n\nNothing is still running.\n\nYou need to: answer it.\n\nACTION NEEDED FROM YOU', CC_ON), 'bare ACTION NEEDED', /reason on the KEEP OPEN/);
  fs.rmSync(chainFileFor(t), { force: true });
  assertAllowed(runHook(t, 'DECISION NEEDED: keep or drop?\n\nNothing is still running.\n\nYou need to: answer the decision.\n\nACTION NEEDED FROM YOU — answer the decision above.', { ...CC_ON, ...WK_ON }), 'ACTION NEEDED needs no wake');
  // A session a routine fires into (weekly spend watch) must not be archived; the routine is its wake.
  assertAllowed(runHook(t, 'Tally emailed.\n\nNothing is still running.\n\nNothing needed from you.\n\nKEEP OPEN — the weekly spend watch fires into this session.', { ...CC_ON, ...WK_ON }), 'routine host');
  assertWakeless(runHook(t, 'Tally emailed.\n\nNothing is still running.\n\nNothing needed from you.\n\nKEEP OPEN — the weekly spend watch runs again Monday.', WK_ON), 'other wording still needs a wake');
  fs.rmSync(chainFileFor(t), { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRO-6020 ship-check: a quoted (>) verdict is no verdict; quoted asks and "no action" are not owner asks; finished waits pass', skipNoRepoHook, () => {
  const dir = makeTmpDir('verdict-quoted');
  const t = writeTranscript(dir, [GIT_PUSH, LINEAR_CLOSEOUT_DONE]);
  // _closing() drops quoted lines, so accepting one here hid the real line from every SAFE gate.
  const r = runHook(t, 'Pushed.\n\n> SAFE TO ARCHIVE — done.');
  assertBlocked(r, 'a blockquoted verdict');
  assert.match(r.stderr, /no closing verdict line/, `expected NOSTATUSLINE, got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(chainFileFor(t), { force: true });
  assertAllowed(runHook(t, 'The template reads:\n> DECISION NEEDED: <what>\n> You need to: <the one thing>\n\nSAFE TO ARCHIVE — docs updated.'), 'quoted template is not an ask');
  assertAllowed(runHook(t, 'You need to: no action.\n\nSAFE TO ARCHIVE — done.'), '"no action"');
  assertAllowed(runHook(t, 'You need to: —\n\nSAFE TO ARCHIVE — done.'), 'bare dash');
  for (const body of ["This session isn't waiting on anything.", 'Landed after waiting for the Land run to go green.',
    'Stopped waiting for the old run; the new one passed.', 'Nobody is waiting on this anymore.']) {
    assertAllowed(runHook(t, `${body}\n\nSAFE TO ARCHIVE — done.`, LE_ON), body);
  }
  fs.rmSync(chainFileFor(t), { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── Passive-offer gate (PASSIVEOFFER, BRO-6546, 2026-10-29) ────────────────
// Owner screenshots: "Say the word and I'll start the landing", "Shall I build
// all of it now?". LOOSEENDS only reads SAFE TO ARCHIVE closings and the status
// gates need edits, so offers under KEEP OPEN / ACTION NEEDED or in a no-edit
// turn passed. Block on any final message unless a DECISION NEEDED: block holds
// the real owner call.
const PO_ON = { PASSIVEOFFER_GATE_DISABLE: '0' };
function assertPassive(r, message) {
  assertBlocked(r, message);
  assert.match(r.stderr, /passive offer|contains an offer/i, `expected the PASSIVEOFFER message, got: ${r.stderr.slice(0, 400)}`);
}

test('PASSIVEOFFER: offers to land/build/review block, with or without edits and under any verdict', skipNoRepoHook, () => {
  const dir = makeTmpDir('passive-block');
  const noEdits = writeTranscript(dir, []);
  const closeout = writeTranscript(dir, [LINEAR_CLOSEOUT_DONE]);
  for (const body of [
    'It is not merged or deployed yet. Say the word and I\'ll start the landing process.',
    'Option 1 is noted. Shall I build all of it now?\n\nKEEP OPEN — waiting on your answer.',
    'The change is on a branch. Check out this PR when you get a chance.\n\nACTION NEEDED FROM YOU — review it.',
    'Want me to land it now?',
    'It\'s not live yet, want me to deploy it?',
    'It isn\u2019t landed, want me to land it?',
    'No errors in CI, and if you want, I can land it now.',
    'Shall I?',
    'All done on my side.\n\nACTION NEEDED FROM YOU \u2014 say the word and I\'ll land it',
    'I haven\'t changed anything. If you want, I can remove the Chicago review and ask the pipeline to ingest King.',
    'The branch is pushed. I could land it once main settles.',
    'Status: SAFE TO ARCHIVE.\n\nIf you want a live check after the rebuild, ping me and I\'ll look at a real show page.',
    'Status: SAFE TO ARCHIVE.\n\nIf it breaks, ping me and I\'ll fix it.',
    'The deploy is live and it works. Let me know and I\'ll land it.',
  ]) {
    assertPassive(runHook(noEdits, body, PO_ON), `no-edit turn: ${body.slice(0, 50)}`);
    assertPassive(runHook(closeout, body, PO_ON), `after work: ${body.slice(0, 50)}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PASSIVEOFFER false-positive guards: a real DECISION NEEDED block, finished work, bypass', skipNoRepoHook, () => {
  const dir = makeTmpDir('passive-allow');
  const noEdits = writeTranscript(dir, []);
  assertAllowed(runHook(noEdits, 'Two ways to price it.\n\nDECISION NEEDED: which price to charge\nWhy this is your call: money.\nOption A — $5: cheap / low margin\nOption B — $9: margin / fewer sign-ups\nMy recommendation: B because margin.\nDefault: B.\n\nACTION NEEDED FROM YOU — pick a price', PO_ON), 'real owner call in the template');
  assertAllowed(runHook(noEdits, 'The new gate blocks "say the word" and "shall I build", so I rewrote the closing.', PO_ON), 'double-quoted citation');
  assertAllowed(runHook(noEdits, 'You don\'t need to check out the PR; I landed it myself.', PO_ON), 'negated clause');
  assertAllowed(runHook(noEdits, 'I took a look at the PR comments, and the child was asked to review the PR.', PO_ON), 'narrative, not an offer');
  assertAllowed(runHook(noEdits, 'The visual check is pending.\n\nYou need to: tap Approve on the screenshots when you\'re ready.\n\nACTION NEEDED FROM YOU — approve the visual check', PO_ON), 'visual-approval ask');
  assertAllowed(runHook(noEdits, 'The Monitor will ping me when it exits, and I\'ll verify the deploy; land.yml will ping me and I\'ll check the run.', PO_ON), 'a monitor or land run pinging me is narration');
  assertAllowed(runHook(noEdits, 'The note `ping me and I\'ll look` is quoted from the old rule.', PO_ON), 'a backticked phrase is a citation');
  assertAllowed(runHook(noEdits, 'CI will ping me and I\'ll check the run; the wake is armed in the background.', PO_ON), 'CI pinging me is narration');
  assertAllowed(runHook(noEdits, 'The reviewer will ping me and I\'ll check the PR when it arrives; the wake is armed in the background.', PO_ON), 'a reviewer pinging me is narration, not an offer');
  assertAllowed(runHook(noEdits, 'I could not verify the deploy, so I re-ran the check and it is live now.', PO_ON), 'I could not <verb> is not an offer');
  for (const msg of [
    'Once main settled I could land it, and I did. It is live.',
    'I could open a card for it, but it is already tracked.',
    'I\'ll have a look at the PR checks once CI finishes.\n\nKEEP OPEN \u2014 CI is running and its exit wakes me.',
    'I told the child session to check out the PR branch and rebase it.',
    'The new gate blocks \u2018say the word\u2019 endings and \'shall I build\' closings.',
  ]) assertAllowed(runHook(noEdits, msg, PO_ON), `narration/citation: ${msg.slice(0, 50)}`);
  assertAllowed(runHook(noEdits, 'Landed and live on the site. The shows page now loads in half the time.', PO_ON), 'finished work');
  assertAllowed(runHook(noEdits, 'The gate matches `say the word` and `shall I build` in closings, and it reviewed the pull request diff itself.', PO_ON), 'quoted code and "reviewed" are not offers');
  assertAllowed(runHook(noEdits, 'Want me to land it now?\nNO-VERIFY: quoting the owner\'s own phrase for a test', PO_ON), 'NO-VERIFY bypass');
  fs.rmSync(dir, { recursive: true, force: true });
});
