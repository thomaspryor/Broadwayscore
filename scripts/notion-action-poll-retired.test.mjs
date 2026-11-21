// BRO-384 (Linear migration Phase 3): the Notion action poller is retired.
//
// This is an integration test on purpose. The thing worth protecting is not a
// predicate — it is that NO invocation shape can reach the sweep that spawns
// Claude sessions from Notion cards. A unit test on an env check would pass
// while a new `--card` fast-path above the guard quietly re-opened it, which is
// precisely the failure this guards against: the poller had no launchd job, no
// crontab entry and no workflow, so "retired" and "happens not to be running
// today" looked identical, and a stray manual run would have resumed spawning
// sessions off the old board.
//
// --help must still work: a retired script that cannot explain itself is worse
// than one that can, and the help path deliberately precedes the guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts', 'notion-action-poll.js');

// Structural assertions must read CODE, not prose. A guard's own comment
// necessarily quotes the thing it is arguing against — this test failed on its
// first run because the guard explains why the hatch is NOT file-shaped by
// naming BOARD_GATE_DISABLED. Same trap as
// scripts/lib/notion-write-guard.test.mjs. A structural test that a comment can
// fool proves nothing.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
}

function run(args, env = {}) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

test('a bare invocation refuses with the retirement exit code', () => {
  const r = run([]);
  assert.equal(r.code, 7, 'retired poller must exit 7, not run');
  assert.match(r.out, /RETIRED/);
  assert.match(r.out, /BRO-384/, 'name the card so the next reader can find out why');
  assert.match(r.out, /linear-next\.js/, 'a refusal without an alternative gets worked around');
});

test('the scoped --card path cannot bypass the guard', () => {
  // --card exists to avoid a full unscoped sweep, so it is the shape most
  // likely to be reached for "just this one card" after retirement.
  const r = run(['--card', '3c0637c5-416f-8181-aa8f-e9881242a937']);
  assert.equal(r.code, 7, '--card must be refused exactly like a bare run');
});

test('--help still works, because a retired script must explain itself', () => {
  const r = run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /Notion Action Queue Poller/);
});

test('the escape hatch is env-only and never silent', () => {
  const src = stripComments(readFileSync(SCRIPT, 'utf8'));
  assert.match(src, /NOTION_POLLER_ALLOWED/, 'override must exist for a genuine one-off');
  // File-shaped hatches outlive the session that set them — BOARD_GATE_DISABLED
  // silently disabled every board gate for six days. An env var expires with the
  // command that carries it.
  assert.ok(
    !/BOARD_GATE_DISABLED|readFileSync\([^)]*POLLER/.test(src),
    'the poller hatch must not be file-shaped'
  );
  assert.match(src, /running a RETIRED poller/, 'using the hatch must log, so a one-off cannot become the norm');
});

test('the guard precedes argument parsing, so no future flag can outrun it', () => {
  const src = stripComments(readFileSync(SCRIPT, 'utf8'));
  const mainIdx = src.indexOf('async function main() {');
  const guardIdx = src.indexOf("process.env.NOTION_POLLER_ALLOWED !== '1'", mainIdx);
  const parseIdx = src.indexOf('CARD_FLAG_PRESENT', mainIdx);
  assert.ok(guardIdx > 0, 'guard must live inside main()');
  assert.ok(parseIdx > 0, 'argument handling must still exist');
  assert.ok(guardIdx < parseIdx, 'the guard must run BEFORE argument handling, or a new flag can route around it');
});
