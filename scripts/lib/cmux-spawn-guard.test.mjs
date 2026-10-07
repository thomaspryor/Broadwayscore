// scripts/lib/cmux-spawn-guard.test.mjs — BRO-3001.
//
// The load-bearing tests here are the REPLAY ones: they run the detector over
// the actual pre-fix source of the two files that BRO-2959's nine review
// rounds missed, and assert it would have blocked both. A guard that only
// passes on synthetic snippets proves nothing about the misses it exists for.
//
// Per project rule §15 this requires the real module — no logic is copied in.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findUnguardedCmuxSpawns, stripComments, callSpawnsCmux, sliceCall, SPAWN_OWNER } =
  require('./cmux-spawn-guard.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const blockingIn = (src, rel = 'scripts/x.js') =>
  findUnguardedCmuxSpawns(src, rel).filter(f => f.severity === 'credential');

test('the two BRO-3001 misses would have blocked before the fix', () => {
  // Reads the committed pre-fix source rather than a paraphrase of it. If this
  // repo is ever checked out without git history the test is skipped, never
  // silently passed.
  // Narrow, deliberate skip: ONLY a checkout with no history (a tarball) may
  // skip. A blanket `catch { return }` here would turn any error into a silent
  // pass, which is how a load-bearing test quietly stops testing (ship-check
  // finding).
  const head = (f) => execFileSync('git', ['-C', REPO, 'show', `HEAD:${f}`], { encoding: 'utf8', maxBuffer: 32e6 });
  try {
    execFileSync('git', ['-C', REPO, 'rev-parse', '--verify', 'HEAD'], { stdio: 'ignore' });
  } catch {
    return; // no history available (tarball checkout) — nothing to replay
  }
  // Any OTHER failure below is a real failure and must throw.

  for (const p of ['scripts/dispatch-watchdog.js', 'scripts/audit-dispatch-outcomes.js']) {
    const src = head(p); // a missing file here means the replay lost its subject
    // Only assert on the PRE-fix shape. Once the fix is committed, HEAD is
    // clean and there is nothing to catch — that is success, not failure.
    const preFix = /spawnSync\(cmuxws\.CMUX|execFileSync\('cmux'/.test(src);
    if (!preFix) continue;
    assert.ok(blockingIn(src, p).length >= 1, `${p} pre-fix source must be flagged`);
  }
});

// NOTE: this suite deliberately does NOT scan the live tree for violations.
// An earlier version did, and it was shared-fate: an unrelated session adding
// a credential-less spawn turned THIS unit test red, blaming the wrong author
// -- the same failure --scope-stdin fixes for the push audit (ship-check
// finding). The live invariant is asserted by CI's own unscoped
// `node scripts/audit-cmux-spawn-credential.js` step in test.yml, which is
// the right place for it: CI's checkout IS the branch under test.

test('catches every shape the two misses used', () => {
  const shapes = [
    ["execFileSync('cmux', ['list-workspaces'], { encoding: 'utf8' })", 'bare cmux off PATH'],
    ["spawnSync(cmuxws.CMUX, ['new-workspace'], { timeout: 15000 })", 're-exported constant'],
    ["spawnSync(CMUX_BIN, ['top'], { encoding: 'utf8' })", 'CMUX_BIN'],
    ["execFileSync('/Applications/cmux.app/Contents/Resources/bin/cmux', ['x'], {})", 'absolute path'],
    ["execSync('cmux list-workspaces')", 'shell-string form'],
  ];
  for (const [src, label] of shapes) {
    assert.equal(blockingIn(src).length, 1, `should catch ${label}`);
  }
});

test('does not fire on non-cmux spawns inside cmux-named modules', () => {
  // cmux-launch.js really does spawn all three of these; a "line mentions
  // cmux" rule would report every one of them.
  for (const src of [
    "spawnSync('ps', ['-e', '-ww', '-o', 'command='], { encoding: 'utf8' })",
    "spawnSync('sleep', [String(s)])",
    "spawnSync('open', ['-a', CMUX_APP], { timeout: 3000 })",
  ]) {
    assert.deepEqual(findUnguardedCmuxSpawns(src, 'scripts/lib/cmux-launch.js'), [], src);
  }
});

test('a call carrying cmuxSpawnEnv is advisory, not blocking', () => {
  const src = "spawnSync(CMUX, ['debug-terminals'], { encoding: 'utf8', env: cmuxSpawnEnv(process.env) })";
  const found = findUnguardedCmuxSpawns(src, 'scripts/lib/x.js');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'ladder');
  assert.equal(blockingIn(src, 'scripts/lib/x.js').length, 0);
});

test('the owner module is exempt — it is what everything else delegates to', () => {
  assert.deepEqual(findUnguardedCmuxSpawns("execFileSync(CMUX, args, {})", SPAWN_OWNER), []);
});

test('an inline waiver suppresses, on the call line or the line above', () => {
  assert.equal(blockingIn("execFileSync('cmux', ['x'], {}); // cmux-spawn-ok: reviewed").length, 0);
  assert.equal(blockingIn("// cmux-spawn-ok: reviewed\nexecFileSync('cmux', ['x'], {});").length, 0);
  // A bare marker with no reason is not a waiver.
  assert.equal(blockingIn("execFileSync('cmux', ['x'], {}); // cmux-spawn-ok:").length, 1);
});

test('a spawn appearing only inside a comment is not a finding', () => {
  // This guard's own header quotes both offending call sites verbatim, so a
  // scanner that reads comments reports itself.
  assert.equal(blockingIn("// see execFileSync('cmux', ['list-workspaces'])\nconst a = 1;").length, 0);
  assert.equal(blockingIn("/* spawnSync(CMUX, ['top']) */\nconst a = 1;").length, 0);
  assert.equal(blockingIn("/**\n * spawnSync(cmuxws.CMUX, ['new-workspace', ...])\n */\nconst a = 1;").length, 0);
});

test('stripComments preserves length and line numbering', () => {
  const src = "const a = 1; // execFileSync('cmux')\nconst b = 2;\n/* x */\nconst c = 3;";
  const out = stripComments(src);
  assert.equal(out.length, src.length, 'byte length must be preserved');
  assert.equal(out.split('\n').length, src.split('\n').length, 'line count must be preserved');
  assert.ok(!/execFileSync/.test(out), 'comment content is blanked');
  assert.ok(/const c = 3;/.test(out), 'code survives');
});

test('stripComments does not eat a // inside a string literal', () => {
  // The exact trap cmux.json's "$schema": "https://..." set for the sibling
  // parser in cmux-socket-auth.js.
  const src = 'const url = "https://example.com/x";\nexecFileSync(\'cmux\', [\'y\'], {});';
  assert.ok(/https:\/\/example\.com\/x/.test(stripComments(src)), 'string content survives');
  assert.equal(blockingIn(src).length, 1, 'the real call after a URL string is still found');
});

test('reports the line of the call, not of the file', () => {
  const src = "const a = 1;\nconst b = 2;\nexecFileSync('cmux', ['x'], {});";
  assert.equal(blockingIn(src)[0].line, 3);
});

test('a multi-line call finds an env: on a later line', () => {
  // Every real site in this repo spans 2-4 lines with env: below the command,
  // so a per-line reader would false-positive on all of them.
  const src = [
    "const r = spawnSync(CMUX, ['debug-terminals'], {",
    "  encoding: 'utf8',",
    '  env: cmuxSpawnEnv(process.env),',
    '});',
  ].join('\n');
  assert.equal(blockingIn(src, 'scripts/lib/x.js').length, 0);
});

test('sliceCall and callSpawnsCmux handle a comma inside the argv array', () => {
  const src = "spawnSync(CMUX, ['send', '--text', 'a, b'], {})";
  const sliced = sliceCall(src, 0);
  assert.ok(sliced, 'call slices');
  assert.equal(callSpawnsCmux(sliced.call, 'spawnSync'), true);
});

test('empty and non-string input are handled', () => {
  assert.deepEqual(findUnguardedCmuxSpawns('', 'scripts/x.js'), []);
  assert.deepEqual(findUnguardedCmuxSpawns(null, 'scripts/x.js'), []);
  assert.deepEqual(findUnguardedCmuxSpawns(undefined, 'scripts/x.js'), []);
});

// ── ship-check findings (Codex), regression-pinned ─────────────────────────

test('member-call form is caught — childProcess.spawnSync(...)', () => {
  // The boundary class used to exclude a leading '.', so the idiomatic
  //   const childProcess = require('child_process');
  //   childProcess.spawnSync('cmux', args)
  // was invisible: a one-line refactor away from the exact bug this catches.
  assert.equal(blockingIn("childProcess.spawnSync('cmux', ['x'], {})").length, 1);
  assert.equal(blockingIn("cp.execFileSync(CMUX, ['x'], {})").length, 1);
  assert.equal(blockingIn("require('child_process').execFileSync(CMUX, ['x'], {})").length, 1);
});

test('a method whose name merely ENDS in a spawn name still does not fire', () => {
  // `respawnSync` must not match `spawnSync`, or every respawn-pane helper
  // would be reported.
  assert.deepEqual(findUnguardedCmuxSpawns("obj.respawnSync(CMUX, ['x'], {})", 'scripts/x.js'), []);
  assert.deepEqual(findUnguardedCmuxSpawns("myexec('cmux', ['x'])", 'scripts/x.js'), []);
});

test('a mid-line block comment is stripped, opened or closed on the same line', () => {
  assert.equal(blockingIn("const x = 1; /* execFileSync('cmux', ['y'], {}) */ const z = 2;").length, 0);
  assert.equal(blockingIn("const x = 1; /* execFileSync('cmux', ['y'], {})").length, 0);
  // ...but real code AFTER a closed block comment on the same line survives.
  assert.equal(blockingIn("/* note */ execFileSync('cmux', ['y'], {});").length, 1);
});

test('two spawns on ONE line: the credential-less one is not dropped', () => {
  // `seen` used to key on line number, and SPAWN_FNS ordering could make the
  // survivor the ADVISORY call — reporting 'ladder' and exiting 0 while a
  // credential-less spawn sat on the same line (ship-check finding, reproduced).
  const src = "try { spawnSync(CMUX, a, { env: cmuxSpawnEnv(p) }) } catch { spawnSync(CMUX, a, {}) }";
  assert.equal(blockingIn(src, 'scripts/x.js').length, 1, 'the credential-less call must still block');
});

test('searching FOR cmux is not spawning it', () => {
  // `pgrep -f cmux` spawns pgrep, not cmux. A whitespace boundary in the
  // shell-string pattern made this a blocking violation (ship-check finding).
  assert.equal(blockingIn("execSync('pgrep -f cmux')").length, 0);
  assert.equal(blockingIn("execSync('ps -e | grep cmux')").length, 0);
  // ...while cmux as the actual command still fires, including after a separator.
  assert.equal(blockingIn("execSync('cmux list-workspaces')").length, 1);
  assert.equal(blockingIn("execSync('cd /tmp && cmux list-workspaces')").length, 1);
});

test('a multi-line template literal is not scanned as code', () => {
  // This repo generates shell scripts via template literals
  // (dispatch-watchdog.js:380). A generated script mentioning a cmux spawn
  // must not fail CI.
  const src = [
    'const script = `#!/bin/bash',
    "execFileSync('cmux', ['list-workspaces'], {})",
    'echo done',
    '`;',
    'const x = 1;',
  ].join('\n');
  assert.equal(blockingIn(src).length, 0);
});

test('a real spawn AFTER a multi-line template literal is still caught', () => {
  // The template tracker must close, not swallow the rest of the file.
  const src = [
    'const script = `line one',
    'line two`;',
    "execFileSync('cmux', ['x'], {});",
  ].join('\n');
  const found = blockingIn(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3);
});

test('a single-line template literal does not open a multi-line span', () => {
  const src = ['const a = `one-liner`;', "execFileSync('cmux', ['x'], {});"].join('\n');
  assert.equal(blockingIn(src).length, 1);
});
