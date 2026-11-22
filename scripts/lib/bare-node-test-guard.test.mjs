// Class guard (BRO-7984): a bare `node --test` at the repo root (no file args,
// e.g. an empty shell variable) runs every file matching node's default
// discovery globs. On 2026-11-21 that ran scripts/sd-parity-test.js, which
// made live ScrapingBee/Bright Data calls and overwrote a tracked data/audit
// file; scripts/newsletter/send-test.mjs (real Resend email) sits in the same
// glob. Every tracked file the globs match that is not a *.test.* file must
// either load scripts/lib/refuse-under-bare-node-test.js as its FIRST
// require/import, or be allowlisted below as a module with no entry-point work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(ROOT, 'scripts', 'lib', 'refuse-under-bare-node-test.js');
const { shouldRefuse } = require(GUARD);

// Node's default --test patterns (Node 22+; .ts/.mts/.cts once type stripping is on).
const EXT = String.raw`\.[cm]?[jt]s$`;
const NODE_DEFAULT_RE = new RegExp(
  String.raw`(^|/)(test-[^/]*|[^/]*[-_]test|[^/]*\.test|test)` + EXT + String.raw`|(^|/)test/.*` + EXT,
);
const TEST_FILE_RE = /\.test\.[cm]?[jt]s$/;

// Modules (imported by other code, no work when run as an entry point under
// the runner). Each needs a reason; a stale entry fails the suite.
const ALLOWLIST = new Map([
  ['scripts/lib/refuse-under-bare-node-test.js', 'the guard itself; as an entry it refuses itself (exit 0)'],
  ['scripts/lib/test-data-write-guard.js', 'library; no main block'],
  ['scripts/lib/test-identity.js', 'library; no main block'],
  ['scripts/lib/test-manifest.js', 'library; main block needs --fix, else prints usage and exits 1 (writes nothing)'],
  ['scripts/lib/test-run-guard.js', 'library; no main block'],
  ['scripts/lib/test-send-marker.js', 'library; no main block'],
  ['scripts/lib/test-yml-manifest-paths.js', 'library; no main block'],
  ['scripts/lib/test-yml-push-paths.js', 'library; no main block'],
  ['scripts/test-show-ranks.ts', 'pure node:test suite (no I/O); safe for discovery to run'],
  ['src/lib/test-fixture-host.ts', 'pure constant module for the Next app'],
  ['tests/e2e/helpers/test.ts', 'Playwright fixture module; throws outside Playwright, no side effects'],
  ['tests/e2e/helpers/ugc-test.ts', 'Playwright fixture module; throws outside Playwright, no side effects'],
]);

function matchedNonTestFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  return out
    .split('\n')
    .filter((f) => f && NODE_DEFAULT_RE.test(f) && !TEST_FILE_RE.test(f) && !/(^|\/)node_modules\//.test(f));
}

// Strip comments crudely (good enough to find the first real require/import).
function firstLoad(src) {
  // Whole-line // comments first: their text can contain `/*` (globs).
  const code = src.replace(/^#!.*$/m, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const m = code.match(/^\s*import\s[^\n]*|\brequire\(\s*['"][^'"]+['"]\s*\)/m);
  return m ? m[0] : null;
}

const NODE_TEST_RE = /from\s+['"](node:)?test['"]|require\(\s*['"](node:)?test['"]\s*\)/;

function guardProblem(src) {
  if (NODE_TEST_RE.test(src)) {
    return 'is a node:test suite: rename it to *.test.* (or allowlist it) instead of guarding it, so bare discovery still runs it';
  }
  const first = firstLoad(src);
  if (!/refuse-under-bare-node-test/.test(src)) return 'never loads scripts/lib/refuse-under-bare-node-test.js';
  if (!first || !/refuse-under-bare-node-test/.test(first)) {
    return `first require/import is \`${first}\`, not the bare-node-test guard (it must load before anything else)`;
  }
  return null;
}

test('the scan finds the known live scripts (guards against a regex that matches nothing)', () => {
  const files = new Set(matchedNonTestFiles());
  for (const known of [
    'scripts/sd-parity-test.js',
    'scripts/newsletter/send-test.mjs',
    'scripts/btc-smoke-test.js',
    'scripts/test-email-broadcast.js',
    'scripts/test-paywalled-access.js',
    'scripts/llm-scoring/test-gemini.ts',
  ].filter((f) => fs.existsSync(path.join(ROOT, f)))) {
    assert.ok(files.has(known), `expected ${known} to match node's default --test globs`);
  }
  assert.ok(files.size >= 10, `only ${files.size} files matched`);
});

test('every non-*.test.* file node --test would pick up loads the guard first or is allowlisted', () => {
  const bad = [];
  for (const rel of matchedNonTestFiles()) {
    if (ALLOWLIST.has(rel)) continue;
    const why = guardProblem(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    if (why) bad.push(`${rel}: ${why}`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('allowlist has no stale entries', () => {
  const files = new Set(matchedNonTestFiles());
  const stale = [...ALLOWLIST.keys()].filter((f) => !files.has(f));
  assert.deepEqual(stale, []);
});

test('red-then-green: the rule flags a missing, late or comment-only guard', () => {
  assert.match(guardProblem("const fs = require('fs');\n"), /never loads/);
  assert.match(guardProblem("import './lib/refuse-under-bare-node-test.js';\nimport { test } from 'node:test';\n"), /node:test suite/);
  assert.match(guardProblem("const fs = require('fs');\nrequire('./lib/refuse-under-bare-node-test');\n"), /first require/);
  assert.match(guardProblem("// require('./lib/refuse-under-bare-node-test')\nconst fs = require('fs');\n"), /first require/);
  assert.match(guardProblem("import fs from 'fs';\nimport './lib/refuse-under-bare-node-test.js';\n"), /first require/);
  assert.equal(guardProblem("#!/usr/bin/env node\n/** doc require('x') */\n'use strict';\nrequire('./lib/refuse-under-bare-node-test');\nconst fs = require('fs');\n"), null);
  assert.equal(guardProblem("import './lib/refuse-under-bare-node-test.js';\nimport fs from 'fs';\n"), null);
  // The real incident file, with its guard line removed, is flagged.
  const sd = fs.readFileSync(path.join(ROOT, 'scripts/sd-parity-test.js'), 'utf8');
  assert.equal(guardProblem(sd), null);
  assert.match(guardProblem(sd.split('\n').filter((l) => !/refuse-under-bare-node-test/.test(l)).join('\n')), /never loads/);
});

test('shouldRefuse: only glob discovery by the runner refuses; direct, explicit and test-spawned runs do not', () => {
  const runner = ['--test-isolation=process'];
  const ctx = { NODE_TEST_CONTEXT: 'child-v8' };
  const sd = ['node', '/r/scripts/sd-parity-test.js'];
  // Bare `node --test`: runner child, parent is the bare runner.
  assert.equal(shouldRefuse({ execArgv: runner, env: ctx, argv: sd, getParentArgs: () => 'node --test' }), true);
  // Parent unreadable: fail safe.
  assert.equal(shouldRefuse({ execArgv: runner, env: ctx, argv: sd, getParentArgs: () => '' }), true);
  // *.test.* entry: never.
  assert.equal(shouldRefuse({ execArgv: runner, env: ctx, argv: ['node', '/r/x.test.mjs'], getParentArgs: () => 'node --test' }), false);
  // Run directly: never (no runner markers).
  assert.equal(shouldRefuse({ execArgv: [], env: {}, argv: sd, getParentArgs: () => 'zsh' }), false);
  // Spawned by a test file: env inherited, parent is `node x.test.mjs`.
  assert.equal(shouldRefuse({ execArgv: [], env: ctx, argv: ['node', '/r/scripts/newsletter/send-test.mjs'], getParentArgs: () => 'node /r/scripts/newsletter/send-test-recipients.test.mjs' }), false);
  // Older Node: no isolation flag, parent is the bare runner.
  assert.equal(shouldRefuse({ execArgv: [], env: { NODE_TEST_CONTEXT: 'child' }, argv: ['node', '/r/scripts/test-image-fetch.js'], getParentArgs: () => 'node --test' }), true);
  // Explicit `node --test <this file>`: runs, so its own exit code counts.
  const real = path.join(ROOT, 'scripts/sd-parity-test.js');
  assert.equal(shouldRefuse({ execArgv: runner, env: ctx, argv: ['node', real], getParentArgs: () => 'node --test scripts/sd-parity-test.js', cwd: ROOT }), false);
  // A different explicit file does not count as naming this one.
  assert.equal(shouldRefuse({ execArgv: runner, env: ctx, argv: ['node', real], getParentArgs: () => 'node --test scripts/btc-smoke-test.js', cwd: ROOT }), true);
});

test('end to end: a bare `node --test` in a scratch dir skips a guarded live script but a test file can still spawn it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7984-'));
  try {
    const marker = path.join(dir, 'WROTE');
    const guardedSrc = `require(${JSON.stringify(GUARD)});\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`;
    fs.writeFileSync(path.join(dir, 'live-test.js'), guardedSrc);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /refusing to run it from node --test's file discovery/);
    assert.equal(fs.existsSync(marker), false, 'guarded script ran its side effect under bare node --test');

    // Explicit `node --test live-test.js` runs it (the caller asked; exit code counts).
    const rx = spawnSync(process.execPath, ['--test', 'live-test.js'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(rx.status, 0, rx.stdout + rx.stderr);
    assert.equal(fs.existsSync(marker), true, 'explicitly named script must run');
    fs.rmSync(marker);

    // RED control: the same script without the guard does write.
    fs.writeFileSync(path.join(dir, 'live-test.js'), guardedSrc.split('\n').slice(1).join('\n'));
    spawnSync(process.execPath, ['--test'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(fs.existsSync(marker), true, 'control: unguarded script should have run');
    fs.rmSync(marker);

    // A *.test.mjs that spawns the guarded script still gets it run.
    fs.writeFileSync(path.join(dir, 'live-test.js'), guardedSrc);
    fs.renameSync(path.join(dir, 'live-test.js'), path.join(dir, 'live-script.js'));
    fs.writeFileSync(
      path.join(dir, 'spawns.test.mjs'),
      `import { execFileSync } from 'node:child_process';\nexecFileSync(process.execPath, [${JSON.stringify(path.join(dir, 'live-script.js'))}]);\n`,
    );
    const r2 = spawnSync(process.execPath, ['--test'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.equal(fs.existsSync(marker), true, 'script spawned by a test file must not be refused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
