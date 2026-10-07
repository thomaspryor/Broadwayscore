// scripts/tests/verify-edits-heredoc.test.mjs
//
// Shell-level test for ~/.claude/hooks/verify-edits.sh's Python
// _strip_heredocs()/_is_review_texts_write() (task #1606).
//
// _strip_heredocs() used to match a heredoc-open at the SECOND '<' of a
// `<<<TAG` here-string (which has no multi-line body at all), then
// DOTALL-greedily consume forward to the next line that happened to equal
// TAG — silently swallowing real command text, including a genuine
// `sed -i .../review-texts/...` write, as fake "heredoc body". That defeated
// _is_review_texts_write()'s audit-sweep gate: the exact false-negative class
// already fixed in stripHeredocBodies() in scripts/lib/infra-review-scope.js
// (task #1557). This file pipes a real Stop-hook JSON payload into the REAL
// hook script over stdin and reads its exit code (0 = allowed, 2 = BLOCKED),
// per the established pattern in scripts/tests/merge-gate-hook.test.mjs —
// not a re-embedded copy of the Python logic, which would drift from the
// shipped file (CLAUDE.md rule 15).
//
// Hook resolution mirrors merge-gate-hook.test.mjs: prefer
// $HOME/.claude/hooks/verify-edits.sh (the copy actually registered for real
// Stop events on this machine) and fall back to the project copy at
// <repo>/.claude/hooks/verify-edits.sh (so cloud sandboxes/CI, which have no
// ~/.claude, still exercise a real copy). The two are meant to be kept
// byte-identical but nothing enforces that automatically — see the
// regression pin below, which always tests a controlled temp copy rather
// than relying on whichever one happens to be resolved.

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

function makeTmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `verify-edits-heredoc-test-${label}-`));
}

// A minimal Stop-hook transcript: one assistant turn whose only tool_use is
// the given Bash command. No Edit/Write tool_use anywhere, so the only way
// this hook can BLOCK is via the ran_audit_sweep path — isolating exactly
// the code path _strip_heredocs() feeds.
function writeTranscript(dir, bashCommand) {
  const p = path.join(dir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'run this command' }] } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', id: `tu-${randomUUID()}`, input: { command: bashCommand } }],
      },
    }),
  ];
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function runHook(hookPath, transcriptPath, env = {}) {
  const stdin = JSON.stringify({
    transcript_path: transcriptPath,
    session_id: `veh-test-${randomUUID()}`,
    stop_hook_active: false,
  });
  const r = spawnSync('bash', [hookPath], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: HOOK_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function assertBlocked(result, message) {
  assert.equal(result.status, 2, `${message} — expected BLOCKED (exit 2), got exit ${result.status}. stderr: ${result.stderr.slice(0, 300)}`);
}
function assertAllowed(result, message) {
  assert.equal(result.status, 0, `${message} — expected allowed (exit 0), got exit ${result.status}. stderr: ${result.stderr.slice(0, 300)}`);
}

// ── case 1: the card's <<<EOF here-string reproduction ─────────────────────
// A here-string (`<<<EOF`) has no multi-line body — the sed -i line and the
// trailing echo are both ordinary, EXECUTED command text, not heredoc data.
// The gate must see the real review-texts write and BLOCK pending
// scoring-delta verification, not silently swallow it.
test('here-string (<<<EOF) reproduction: a real sed -i review-texts write is NOT swallowed — hook BLOCKS', skipNoHook, () => {
  const dir = makeTmpDir('case1');
  const cmd = 'printf x <<<EOF\nsed -i s/x/y/ data/review-texts/some-show/critic.txt\necho unrelated marker line\nEOF\n';
  const transcript = writeTranscript(dir, cmd);
  const r = runHook(HOOK, transcript);
  assertBlocked(r, 'here-string real write');
  assert.match(r.stderr, /audit sweep/i, `expected the audit-sweep block message, got: ${r.stderr.slice(0, 300)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── case 2: the 2026-05-16 regression case — genuine heredoc body ─────────
// verify-edits.sh's own header comment describes this exact case: a real
// heredoc (`<< 'EOF'`) whose BODY happens to contain sed -i/review-texts
// text. That text is heredoc DATA (this command's actual side effect is
// writing to /tmp/), so it must be stripped and must NOT trip the gate.
test('genuine heredoc (2026-05-16 regression case): sed -i/review-texts text INSIDE a real heredoc body still strips correctly — hook ALLOWS', skipNoHook, () => {
  const dir = makeTmpDir('case2');
  const cmd = "cat > /tmp/verify-edits-heredoc-test.jsonl << 'EOF'\nsed -i s/x/y/ data/review-texts/some-show/critic.txt\nEOF\necho done\n";
  const transcript = writeTranscript(dir, cmd);
  const r = runHook(HOOK, transcript);
  assertAllowed(r, 'genuine heredoc body');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── case 3: multiple heredocs opened on one line ────────────────────────────
// `cmd <<A <<B` — real bash consumes A's body up to A's own terminator, then
// B's body immediately after. A body line that coincidentally matches B's tag
// must not end the strip early (this was a defect in an earlier draft of the
// JS port, per infra-review-scope.js's own comments).
test('multiple heredocs opened on one line: both bodies strip in order, a real trailing write survives', skipNoHook, () => {
  const dir = makeTmpDir('case3');
  const cmd = "cmd <<A <<B\nbodyA line one\nA\nbodyB line one\nB\nsed -i s/x/y/ data/review-texts/some-show/critic.txt\n";
  const transcript = writeTranscript(dir, cmd);
  const r = runHook(HOOK, transcript);
  assertBlocked(r, 'multi-heredoc real write after both bodies');
  assert.match(r.stderr, /audit sweep/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── regression pin: revert to the buggy regex, prove case 1 would fail ────
// A test suite that stays green against a BROKEN hook is worthless. Patch a
// standalone temp copy of the live hook back to the pre-#1606 regex and
// prove case 1's assertion would NOT have caught the false negative (hook
// fails open — exit 0 — on a real review-texts write hidden behind a
// here-string). HOME is pointed at an empty fake dir for this subprocess so
// the hook's own self-skip preamble (`[ -f "$HOME/.claude/hooks/..." ]`)
// does not fire before reaching the patched line — mirrors the fakeHome
// technique in merge-gate-hook.test.mjs.
test('regression pin: reverting to the pre-#1606 heredoc regex re-introduces the here-string false negative', skipNoHook, () => {
  const original = fs.readFileSync(HOOK, 'utf8');
  const openNeedle = '_heredoc_open_re = re.compile(';
  assert.ok(original.includes(openNeedle), 'the live hook no longer contains the expected _heredoc_open_re — update this pin to match its current form');

  // Splice the OLD single-regex-substitution implementation in place of the
  // new line-by-line scanner, bounded by the two anchors that are stable
  // across the fix (the header comment stays before, `def _strip_heredocs`
  // reappears at the START of the new definition too).
  const startMarker = '_heredoc_open_re = re.compile(';
  const endMarker = "    return '\\n'.join(out)\n";
  const startIdx = original.indexOf(startMarker);
  const endIdx = original.indexOf(endMarker, startIdx);
  assert.ok(startIdx !== -1 && endIdx !== -1, 'could not locate the _strip_heredocs implementation block to splice — update this pin');
  const oldImpl =
    "_heredoc_re = re.compile(\n" +
    "    r\"<<-?\\s*['\\\"]?(\\w+)['\\\"]?\\n.*?^\\1\\s*$\",\n" +
    "    re.MULTILINE | re.DOTALL,\n" +
    ")\n" +
    "def _strip_heredocs(cmd: str) -> str:\n" +
    "    return _heredoc_re.sub('', cmd)\n";
  const broken = original.slice(0, startIdx) + oldImpl + original.slice(endIdx + endMarker.length);
  assert.ok(!broken.includes('_heredoc_open_re'), 'splice failed to fully remove the fixed implementation');

  const tdir = makeTmpDir('broken-hook');
  const fakeHome = path.join(tdir, 'fake-home'); // no .claude/hooks/ here — defeats the self-skip preamble
  fs.mkdirSync(fakeHome, { recursive: true });
  const brokenPath = path.join(tdir, 'verify-edits-broken.sh');
  fs.writeFileSync(brokenPath, broken);
  fs.chmodSync(brokenPath, 0o755);
  try {
    const cmd = 'printf x <<<EOF\nsed -i s/x/y/ data/review-texts/some-show/critic.txt\necho unrelated marker line\nEOF\n';
    const transcript = writeTranscript(tdir, cmd);
    const r = runHook(brokenPath, transcript, { HOME: fakeHome });
    assert.equal(r.status, 0, 'the broken hook should fail to BLOCK a real review-texts write hidden behind a here-string — proving this suite has teeth');
  } finally {
    fs.rmSync(tdir, { recursive: true, force: true });
  }
});

// Companion sanity check: the SAME fakeHome/self-skip-defeat plumbing, with
// an UNPATCHED copy, must still BLOCK on case 1 — otherwise the regression
// pin above would pass for the wrong reason (fakeHome breaking something
// else), not because of the reverted regex specifically.
test('regression pin sanity: the fakeHome plumbing alone does not change the verdict — an unpatched copy still BLOCKS', skipNoHook, () => {
  const original = fs.readFileSync(HOOK, 'utf8');
  const tdir = makeTmpDir('unpatched-hook');
  const fakeHome = path.join(tdir, 'fake-home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const copyPath = path.join(tdir, 'verify-edits-copy.sh');
  fs.writeFileSync(copyPath, original);
  fs.chmodSync(copyPath, 0o755);
  try {
    const cmd = 'printf x <<<EOF\nsed -i s/x/y/ data/review-texts/some-show/critic.txt\necho unrelated marker line\nEOF\n';
    const transcript = writeTranscript(tdir, cmd);
    const r = runHook(copyPath, transcript, { HOME: fakeHome });
    assertBlocked(r, 'unpatched copy under fakeHome');
  } finally {
    fs.rmSync(tdir, { recursive: true, force: true });
  }
});
