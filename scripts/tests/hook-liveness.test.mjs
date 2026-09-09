// timebomb-audit-exempt: checkGuardHeartbeat (infra-gate-registration-check.js:656)
//   derives heartbeat age from fs.statSync(...).mtimeMs vs Date.now().
//   audit-time-bomb-tests.js shifts the PROCESS clock but not the FILESYSTEM, so
//   the heartbeat always reads as stale under a shifted run. Not a real time bomb.
// scripts/tests/hook-liveness.test.mjs
//
// Acceptance test for task #1104: the hook-liveness check watched exactly
// ONE hook (infra-plan-review-gate.sh, via scripts/lib/infra-gate-
// registration-check.js's original four checks). On 2026-08-06,
// hook-syntax-guard.sh quarantined TWO healthy hooks in the same run —
// infra-plan-review-gate.sh was caught because that file watches it by
// name; notion-card-required-stop.sh was silently disabled for ~4 hours
// because nothing watched it at all. This tests the generalization
// (runHookLivenessCheck + friends, same lib file) that treats every hook
// command registered in a settings.json as something that must be alive,
// not just the one this repo happens to have a synthetic-block probe for.
//
// Per CLAUDE.md rule 15 this require()s the REAL functions from
// scripts/lib/infra-gate-registration-check.js — it does not restate them.
// All fixtures here are self-contained temp directories; nothing reads this
// machine's real ~/.claude, so this runs identically in CI and locally.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const check = require('../lib/infra-gate-registration-check.js');

const {
  interpFor,
  checkHookLiveness,
  extractHookCommandPaths,
  commandInvokesPathDirectly,
  resolveHookPath,
  loadRegisteredHooks,
  runHookLivenessCheck,
  checkGuardHeartbeat,
  buildHookLivenessAlertPayload,
} = check;

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hook-liveness-test-'));
}

function writeHook(dir, relPath, content, { executable = true } = {}) {
  const p = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (executable) fs.chmodSync(p, 0o755);
  return p;
}

// entries: [{ event, matcher, command }]
function settingsWith(entries) {
  const hooks = {};
  for (const e of entries) {
    hooks[e.event] = hooks[e.event] || [];
    hooks[e.event].push({ matcher: e.matcher || 'Bash', hooks: [{ type: 'command', command: e.command }] });
  }
  return { hooks };
}

function writeSettings(dir, entries) {
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settingsWith(entries)));
  return settingsPath;
}

// ── (a)-(d): the four acceptance criteria from the card, verbatim ──────────

test('(a) a hook registered in settings.json but absent from disk is reported', () => {
  const dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, 'hooks'));
  const settingsPath = writeSettings(dir, [
    { event: 'PreToolUse', command: 'bash ~/hooks/missing-hook.sh' },
  ]);
  const result = runHookLivenessCheck({
    settingsSources: [{ settingsPath, homeDir: dir, baseDir: dir, label: 'test' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.hooks.length, 1);
  assert.equal(result.hooks[0].ok, false);
  assert.match(result.hooks[0].detail, /missing/);
  assert.match(result.summary, /missing-hook\.sh/);
});

test('(b) a hook present but unparseable under its declared interpreter is reported', () => {
  const dir = makeTmpDir();
  writeHook(dir, 'hooks/broken.sh', '#!/usr/bin/env bash\nif [ true ]; then\n  echo "unterminated if"\n');
  const settingsPath = writeSettings(dir, [
    { event: 'PreToolUse', command: 'bash ~/hooks/broken.sh' },
  ]);
  const result = runHookLivenessCheck({
    settingsSources: [{ settingsPath, homeDir: dir, baseDir: dir, label: 'test' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.hooks[0].ok, false);
  assert.match(result.hooks[0].detail, /does not parse/);
  assert.match(result.summary, /broken\.sh/);
});

test('(c) a hook with a non-shell shebang (#!/usr/bin/env zsh) is NOT reported as broken', () => {
  const dir = makeTmpDir();
  writeHook(dir, 'hooks/zsh-hook.sh', '#!/usr/bin/env zsh\necho hi\n');
  const settingsPath = writeSettings(dir, [
    { event: 'PreToolUse', command: 'bash ~/hooks/zsh-hook.sh' },
  ]);
  const result = runHookLivenessCheck({
    settingsSources: [{ settingsPath, homeDir: dir, baseDir: dir, label: 'test' }],
  });
  assert.equal(result.ok, true, result.summary);
  assert.equal(result.hooks[0].ok, true);
  assert.equal(result.hooks[0].unvalidatable, true);
});

test('(d) a fully healthy hook set reports clean', () => {
  const dir = makeTmpDir();
  writeHook(dir, 'hooks/good-a.sh', '#!/usr/bin/env bash\necho a\n');
  writeHook(dir, 'hooks/good-b.sh', '#!/usr/bin/env bash\necho b\n');
  const settingsPath = writeSettings(dir, [
    { event: 'PreToolUse', command: 'bash ~/hooks/good-a.sh' },
    { event: 'Stop', command: 'bash ~/hooks/good-b.sh' },
  ]);
  const result = runHookLivenessCheck({
    settingsSources: [{ settingsPath, homeDir: dir, baseDir: dir, label: 'test' }],
  });
  assert.equal(result.ok, true, result.summary);
  assert.equal(result.hookCount, 2);
  assert.ok(result.hooks.every((h) => h.ok));
});

// ── naming: 2-hook fixture, only 1 missing, output must name it ────────────

test('the check names the specific hook in its output — fixture with 2 hooks where only 1 is missing', () => {
  const dir = makeTmpDir();
  writeHook(dir, 'hooks/present-hook.sh', '#!/usr/bin/env bash\nexit 0\n');
  // hooks/absent-hook.sh deliberately not written
  const settingsPath = writeSettings(dir, [
    { event: 'PreToolUse', command: 'bash ~/hooks/present-hook.sh' },
    { event: 'Stop', command: 'bash ~/hooks/absent-hook.sh' },
  ]);
  const result = runHookLivenessCheck({
    settingsSources: [{ settingsPath, homeDir: dir, baseDir: dir, label: 'test' }],
  });
  assert.equal(result.ok, false);
  const present = result.hooks.find((h) => path.basename(h.absPath) === 'present-hook.sh');
  const absent = result.hooks.find((h) => path.basename(h.absPath) === 'absent-hook.sh');
  assert.equal(present.ok, true, present.detail);
  assert.equal(absent.ok, false);
  assert.match(result.summary, /absent-hook\.sh/, 'summary must name the broken hook');
  assert.doesNotMatch(result.summary, /present-hook\.sh/, 'summary must not implicate the healthy hook');
});

// ── interpFor: unit coverage of the interpreter-resolution port ────────────

test('interpFor resolves "#!/usr/bin/env bash" to a modern bash, never a bare "bash" PATH lookup', () => {
  const dir = makeTmpDir();
  const p = writeHook(dir, 'hook.sh', '#!/usr/bin/env bash\necho hi\n');
  const interp = interpFor(p);
  assert.ok(path.isAbsolute(interp), `expected an absolute path, got ${interp}`);
  assert.match(interp, /bash$/);
});

test('interpFor resolves a literal "#!/bin/sh" shebang to /bin/sh', () => {
  const dir = makeTmpDir();
  const p = writeHook(dir, 'hook.sh', '#!/bin/sh\necho hi\n');
  assert.equal(interpFor(p), '/bin/sh');
});

test('interpFor does not mistake "#!/bin/bash" for the /sh-suffix arm', () => {
  const dir = makeTmpDir();
  const p = writeHook(dir, 'hook.sh', '#!/bin/bash\necho hi\n');
  assert.equal(interpFor(p), '/bin/bash');
});

test('interpFor returns UNVALIDATABLE for a non-shell interpreter (env python3)', () => {
  const dir = makeTmpDir();
  const p = writeHook(dir, 'hook.py', '#!/usr/bin/env python3\nprint("hi")\n');
  assert.equal(interpFor(p), 'UNVALIDATABLE');
});

test('interpFor returns UNVALIDATABLE for a file with no shebang', () => {
  const dir = makeTmpDir();
  const p = writeHook(dir, 'hook.sh', 'echo hi\n');
  assert.equal(interpFor(p), 'UNVALIDATABLE');
});

test('interpFor handles "env -S bash -e"', () => {
  const dir = makeTmpDir();
  const p = writeHook(dir, 'hook.sh', '#!/usr/bin/env -S bash -e\necho hi\n');
  assert.match(interpFor(p), /bash$/);
});

// ── checkHookLiveness: unit coverage of file-level assertions ──────────────

test('checkHookLiveness FAILS on a missing file', () => {
  const dir = makeTmpDir();
  const r = checkHookLiveness({ hookPath: path.join(dir, 'nope.sh') });
  assert.equal(r.ok, false);
  assert.match(r.detail, /missing/);
});

test('checkHookLiveness FAILS on an empty file', () => {
  const dir = makeTmpDir();
  const p = writeHook(dir, 'empty.sh', '');
  const r = checkHookLiveness({ hookPath: p });
  assert.equal(r.ok, false);
  assert.match(r.detail, /empty/);
});

test('checkHookLiveness FAILS on a non-executable file', () => {
  const dir = makeTmpDir();
  const p = writeHook(dir, 'not-exec.sh', '#!/usr/bin/env bash\necho hi\n', { executable: false });
  const r = checkHookLiveness({ hookPath: p });
  assert.equal(r.ok, false);
  assert.match(r.detail, /not executable/);
});

test('checkHookLiveness PASSES on a present, executable, parseable file', () => {
  const dir = makeTmpDir();
  const p = writeHook(dir, 'good.sh', '#!/usr/bin/env bash\necho hi\n');
  const r = checkHookLiveness({ hookPath: p });
  assert.equal(r.ok, true, r.detail);
});

test('checkHookLiveness PASSES on a non-executable file when requireExecutable=false', () => {
  const dir = makeTmpDir();
  const p = writeHook(dir, 'not-exec.sh', '#!/usr/bin/env bash\necho hi\n', { executable: false });
  const r = checkHookLiveness({ hookPath: p, requireExecutable: false });
  assert.equal(r.ok, true, r.detail);
});

// ── commandInvokesPathDirectly: the real-world case that surfaced this ─────
// (memory-index-cap-postcheck.sh is 644 on the dev machine and has run fine
// since 2026-06-05, because its command is "bash ~/.claude/hooks/x.sh" —
// exec permission on the file itself is never load-bearing for that shape.)

test('commandInvokesPathDirectly is false for "bash <path>"', () => {
  assert.equal(commandInvokesPathDirectly('bash ~/.claude/hooks/x.sh', '~/.claude/hooks/x.sh'), false);
});

test('commandInvokesPathDirectly is false for a quoted "bash -lc \'<path>\'" wrapper', () => {
  assert.equal(commandInvokesPathDirectly("bash -lc '~/.claude/hooks/notify.sh'", '~/.claude/hooks/notify.sh'), false);
});

test('commandInvokesPathDirectly is true for a bare path with no interpreter prefix', () => {
  assert.equal(commandInvokesPathDirectly('~/.claude/hooks/x.sh', '~/.claude/hooks/x.sh'), true);
});

test('runHookLivenessCheck does NOT fail a non-executable hook whose command explicitly invokes bash', () => {
  const dir = makeTmpDir();
  writeHook(dir, 'hooks/registered-644.sh', '#!/usr/bin/env bash\necho hi\n', { executable: false });
  const settingsPath = writeSettings(dir, [
    { event: 'PostToolUse', command: 'bash ~/hooks/registered-644.sh' },
  ]);
  const result = runHookLivenessCheck({
    settingsSources: [{ settingsPath, homeDir: dir, baseDir: dir, label: 'test' }],
  });
  assert.equal(result.ok, true, result.summary);
});

test('runHookLivenessCheck DOES fail a non-executable hook whose command invokes the path directly (no interpreter)', () => {
  const dir = makeTmpDir();
  writeHook(dir, 'hooks/bare-exec.sh', '#!/usr/bin/env bash\necho hi\n', { executable: false });
  const settingsPath = writeSettings(dir, [
    { event: 'PostToolUse', command: '~/hooks/bare-exec.sh' },
  ]);
  const result = runHookLivenessCheck({
    settingsSources: [{ settingsPath, homeDir: dir, baseDir: dir, label: 'test' }],
  });
  assert.equal(result.ok, false);
  assert.match(result.hooks[0].detail, /not executable/);
});

// ── extractHookCommandPaths / resolveHookPath: parsing real settings.json shapes ──

test('extractHookCommandPaths pulls the .sh path out of a quoted "bash -lc \'...\'" wrapper', () => {
  const settings = settingsWith([{ event: 'Stop', command: "bash -lc '~/.claude/hooks/notify.sh'" }]);
  const { matched, unmatched } = extractHookCommandPaths(settings);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].rawPath, '~/.claude/hooks/notify.sh');
  assert.equal(unmatched.length, 0);
});

test('extractHookCommandPaths pulls a repo-relative path starting with "."', () => {
  const settings = settingsWith([{ event: 'PreToolUse', command: 'bash .claude/hooks/notion-create-block.sh' }]);
  const { matched } = extractHookCommandPaths(settings);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].rawPath, '.claude/hooks/notion-create-block.sh');
});

test('extractHookCommandPaths walks every hook-event key, not just PreToolUse', () => {
  const settings = settingsWith([
    { event: 'PreToolUse', command: 'bash ~/hooks/a.sh' },
    { event: 'PostToolUse', command: 'bash ~/hooks/b.sh' },
    { event: 'Stop', command: 'bash ~/hooks/c.sh' },
    { event: 'SessionStart', command: 'bash ~/hooks/d.sh' },
  ]);
  const { matched } = extractHookCommandPaths(settings);
  assert.deepEqual(matched.map((e) => e.event).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
});

test('extractHookCommandPaths pulls the relative suffix out of a CLAUDE_PROJECT_DIR-anchored resolver, not the "/" glued to the variable (BRO-2439 regression)', () => {
  const settings = settingsWith([{
    event: 'PreToolUse',
    command: 'G="$(git rev-parse --show-toplevel 2>/dev/null)"; R="${CLAUDE_PROJECT_DIR:-$G}"; H="$R/.claude/hooks/worktree-enforce.sh"; if [ -n "$R" ] && [ -f "$H" ]; then exec bash "$H"; else echo "FATAL: cannot resolve hook script $H" >&2; exit 2; fi',
  }]);
  const { matched } = extractHookCommandPaths(settings);
  assert.equal(matched.length, 1);
  // Must be the bare relative suffix (resolved against baseDir/repo root),
  // NOT "/.claude/hooks/worktree-enforce.sh" — the naive absolute-looking
  // match a bare `[~./]` start-class would produce by matching the "/" that
  // immediately follows "$R", which then resolves to a nonexistent path at
  // filesystem root and reports every hook as dead (the regression this
  // guards against).
  assert.equal(matched[0].rawPath, '.claude/hooks/worktree-enforce.sh');
});

test('extractHookCommandPaths reports a command with no recognizable .sh path as unmatched, not silently dropped', () => {
  const settings = settingsWith([{ event: 'PreToolUse', command: 'node ~/.claude/hooks/future-hook.mjs' }]);
  const { matched, unmatched } = extractHookCommandPaths(settings);
  assert.equal(matched.length, 0);
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].command, 'node ~/.claude/hooks/future-hook.mjs');
});

test('runHookLivenessCheck FAILS and names the exact command when a hook command has no recognizable path (coverage-gap guard)', () => {
  const dir = makeTmpDir();
  const settingsPath = writeSettings(dir, [
    { event: 'PreToolUse', command: 'node ~/.claude/hooks/future-hook.mjs' },
  ]);
  const result = runHookLivenessCheck({
    settingsSources: [{ settingsPath, homeDir: dir, baseDir: dir, label: 'test' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.unmatchedCommands.length, 1);
  assert.match(result.summary, /future-hook\.mjs/);
});

test('resolveHookPath expands "~/" against homeDir', () => {
  assert.equal(resolveHookPath('~/.claude/hooks/x.sh', { homeDir: '/Users/x', baseDir: '/repo' }), '/Users/x/.claude/hooks/x.sh');
});

test('resolveHookPath resolves a relative path against baseDir (repo root)', () => {
  assert.equal(resolveHookPath('.claude/hooks/x.sh', { homeDir: '/Users/x', baseDir: '/repo' }), '/repo/.claude/hooks/x.sh');
});

test('resolveHookPath passes an absolute path through unchanged', () => {
  assert.equal(resolveHookPath('/opt/hooks/x.sh', { homeDir: '/Users/x', baseDir: '/repo' }), '/opt/hooks/x.sh');
});

test('loadRegisteredHooks FAILS when settings.json is missing', () => {
  const dir = makeTmpDir();
  const r = loadRegisteredHooks({ settingsPath: path.join(dir, 'nope.json'), homeDir: dir, baseDir: dir, label: 'test' });
  assert.equal(r.ok, false);
  assert.match(r.detail, /not found/);
});

// ── the #1079 gate keeps its extra synthetic-block probe, layered in ───────

test('runHookLivenessCheck layers the synthetic-block probe onto infra-plan-review-gate.sh specifically, and FAILS if it does not actually block', () => {
  const dir = makeTmpDir();
  // Present, executable, parseable — but does NOT block (exit 0 instead of 2).
  writeHook(dir, 'hooks/infra-plan-review-gate.sh', '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n');
  const settingsPath = writeSettings(dir, [
    { event: 'PreToolUse', command: 'bash ~/hooks/infra-plan-review-gate.sh' },
  ]);
  const result = runHookLivenessCheck({
    settingsSources: [{ settingsPath, homeDir: dir, baseDir: dir, label: 'test' }],
    repoRoot: REPO_ROOT,
    sessionId: `hook-liveness-test-${randomUUID()}`,
  });
  assert.equal(result.ok, false);
  assert.equal(result.hooks[0].ok, false);
  assert.match(result.hooks[0].detail, /SYNTHETIC-BLOCK PROBE FAILED/);
});

test('runHookLivenessCheck does NOT run the synthetic-block probe against hooks other than infra-plan-review-gate.sh', () => {
  const dir = makeTmpDir();
  // Any other hook exiting 0 is normal, healthy behaviour — must not be probed.
  writeHook(dir, 'hooks/some-other-hook.sh', '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n');
  const settingsPath = writeSettings(dir, [
    { event: 'PreToolUse', command: 'bash ~/hooks/some-other-hook.sh' },
  ]);
  const result = runHookLivenessCheck({
    settingsSources: [{ settingsPath, homeDir: dir, baseDir: dir, label: 'test' }],
    repoRoot: REPO_ROOT,
    sessionId: `hook-liveness-test-${randomUUID()}`,
  });
  assert.equal(result.ok, true, result.summary);
});

// ── settings-source failure (e.g. a whole settings.json missing) surfaces too ──

test('a missing settings.json source is reported as a source failure, not silently skipped', () => {
  const dir = makeTmpDir();
  const result = runHookLivenessCheck({
    settingsSources: [{ settingsPath: path.join(dir, 'nope.json'), homeDir: dir, baseDir: dir, label: 'user (~/.claude)' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.sourceFailures.length, 1);
  assert.match(result.summary, /user \(~\/\.claude\)/);
});

// ── checkGuardHeartbeat: the "silently unloaded" gap the card also flagged ──
//
// Uses a dedicated heartbeat file, NOT the guard's verbose log: the real log
// on this machine only grows on a quarantine/restore event (its own comment:
// "only log quiet runs occasionally"), so checking ITS mtime would false-
// alarm on every calm stretch — most of the time. hook-syntax-guard.sh was
// updated (task #1104) to stamp a separate heartbeat file unconditionally,
// every run, specifically so this check has an "alive" signal independent of
// whether anything broke.

test('checkGuardHeartbeat FAILS when the launchd job is not in the loaded-jobs list', () => {
  const dir = makeTmpDir();
  const heartbeatPath = writeHook(dir, 'guard.heartbeat', '1786040000\n', { executable: false });
  const r = checkGuardHeartbeat({ heartbeatPath, launchctlOutput: 'PID\tStatus\tLabel\n123\t0\tcom.other.job\n' });
  assert.equal(r.ok, false);
  assert.match(r.detail, /not loaded/);
});

test('checkGuardHeartbeat does NOT treat a DIFFERENT job whose label merely contains ours as loaded (exact match, not substring)', () => {
  // The exact bug class that already bit hook-syntax-guard.sh's own restore
  // loop (unanchored "notify.sh" matching "config-change-notify.sh",
  // 2026-08-06) — a substring launchctl-list check would wrongly trust
  // "com.broadwayscore.hook-syntax-guard-v2" as if it were the real job.
  const dir = makeTmpDir();
  const heartbeatPath = writeHook(dir, 'guard.heartbeat', '1786040000\n', { executable: false });
  const r = checkGuardHeartbeat({
    heartbeatPath,
    launchctlOutput: '123\t0\tcom.broadwayscore.hook-syntax-guard-v2\n',
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /not loaded/);
});

test('checkGuardHeartbeat FAILS when the job is loaded but the heartbeat has not been stamped recently', () => {
  const dir = makeTmpDir();
  const heartbeatPath = writeHook(dir, 'guard.heartbeat', '1786040000\n', { executable: false });
  const oldTime = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
  fs.utimesSync(heartbeatPath, oldTime, oldTime);
  const r = checkGuardHeartbeat({
    heartbeatPath,
    maxAgeMinutes: 10,
    launchctlOutput: '123\t0\tcom.broadwayscore.hook-syntax-guard\n',
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /stalled/);
});

test('checkGuardHeartbeat PASSES when the job is loaded and the heartbeat is fresh', () => {
  const dir = makeTmpDir();
  const heartbeatPath = writeHook(dir, 'guard.heartbeat', '1786040000\n', { executable: false });
  const r = checkGuardHeartbeat({
    heartbeatPath,
    maxAgeMinutes: 10,
    launchctlOutput: '123\t0\tcom.broadwayscore.hook-syntax-guard\n',
  });
  assert.equal(r.ok, true, r.detail);
});

test('checkGuardHeartbeat FAILS when the heartbeat file is missing even if the job reports loaded', () => {
  const dir = makeTmpDir();
  const r = checkGuardHeartbeat({
    heartbeatPath: path.join(dir, 'no-such.heartbeat'),
    launchctlOutput: '123\t0\tcom.broadwayscore.hook-syntax-guard\n',
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /missing/);
});

// ── buildHookLivenessAlertPayload: names the broken hooks, digest disposition ──

test('buildHookLivenessAlertPayload names the specific broken hook(s) and is digest/error', () => {
  const result = {
    ok: false,
    summary: 'boom',
    hooks: [
      { ok: false, absPath: '/x/notion-card-required-stop.sh' },
      { ok: true, absPath: '/x/healthy.sh' },
    ],
    sourceFailures: [],
  };
  const payload = buildHookLivenessAlertPayload(result);
  assert.equal(payload.disposition, 'digest');
  assert.equal(payload.severity, 'error');
  assert.equal(payload.conditionKey, 'hook-liveness:broken');
  assert.match(payload.title, /notion-card-required-stop\.sh/);
  assert.doesNotMatch(payload.title, /healthy\.sh/);
});

// ── (b) live-machine: only meaningful where ~/.claude is installed ─────────

const REAL_HOME = os.homedir();
const hasClaudeHooksDir = fs.existsSync(path.join(REAL_HOME, '.claude', 'hooks'));

test(
  '(b) on this machine, every hook registered in ~/.claude/settings.json is alive',
  { skip: !hasClaudeHooksDir && 'no ~/.claude/hooks on this machine (expected in CI)' },
  () => {
    const settingsPath = path.join(REAL_HOME, '.claude', 'settings.json');
    const result = runHookLivenessCheck({
      settingsSources: [{ settingsPath, homeDir: REAL_HOME, baseDir: REAL_HOME, label: 'user (~/.claude)' }],
      repoRoot: REPO_ROOT,
      sessionId: `hook-liveness-test-${randomUUID()}`,
    });
    assert.equal(result.ok, true, result.summary);
  }
);
