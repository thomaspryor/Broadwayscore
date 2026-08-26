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
  assert.match(r.stderr, /merge it yourself/i, `expected the PR-follow-through gate's own message (not a different gate's), got: ${r.stderr.slice(0, 300)}`);
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
  assert.match(r.stderr, /merge it yourself/i, `expected the merge-it-yourself reminder, got: ${r.stderr.slice(0, 300)}`);
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
