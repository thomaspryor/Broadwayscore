// scripts/check-linear-drain-health.test.mjs — CLI-level regression tests.
//
// These exist because every pure-function test passed while the real pipeline
// was silently broken. `node linear-drain-parked.js --dry-run --cap 1000 |
// node check-linear-drain-health.js` reported "inconclusive" and exit 0 — a
// permanently-green monitor — and only running the actual binaries end to end
// surfaced it. Unit tests over assessDrainHealth/parseEligibleCount cannot see
// this class of bug at all, because the bug was in how stdin got read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = new URL('./check-linear-drain-health.js', import.meta.url).pathname;

function ledgerWith(rows) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drainhealth-')), 'l.jsonl');
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n'));
  return f;
}

// Run the CLI with `input` on stdin, returning {status, stdout, stderr}.
function run(args, input) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

const fresh = [{ ts: new Date().toISOString(), event: 'drain-parked-dispatch', identifier: 'BRO-1' }];
const stale = [{ ts: new Date(Date.now() - 40 * 3600e3).toISOString(), event: 'drain-parked-dispatch', identifier: 'BRO-1' }];
const SUMMARY = '[linear-drain-parked] DRY RUN: 36 candidate(s), no dispatch/ledger writes\n';

test('a SLOW producer piping real output still parses — the EAGAIN regression', () => {
  // Reading process.stdin.isTTY INSTANTIATES the stdin stream, which flips fd 0
  // to non-blocking; fs.readFileSync(0) then threw EAGAIN whenever the producer
  // had not already filled the pipe buffer. A fast `echo` masked it completely,
  // which is why the manual spot-check passed and the real pipeline did not.
  // The delay here is what makes this a regression test rather than a tautology.
  const slow = `node -e "setTimeout(()=>process.stdout.write('[linear-drain-parked] DRY RUN: 36 candidate(s), no dispatch/ledger writes\\n'),400)"`;
  const out = execFileSync('bash', ['-c', `${slow} | node ${CLI} --ledger ${ledgerWith(stale)} || true`], { encoding: 'utf8' });
  assert.match(out, /stale/, `slow pipe must still parse the count; got: ${out}`);
  assert.match(out, /36 issue\(s\) eligible/);
});

test('empty piped input is a LOUD failure, never a green inconclusive', () => {
  const r = run(['--ledger', ledgerWith(stale)], '');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /piped input was empty/);
});

test('unparseable drain output is a LOUD failure — the log format changed', () => {
  const r = run(['--ledger', ledgerWith(stale)], 'some totally different output\nnothing to see\n');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /log format has changed/);
});

test('the kill-switch line is inconclusive-but-exit-0, not a format error', () => {
  const r = run(['--ledger', ledgerWith(stale)], '[linear-drain-parked] LINEAR_NEXT_DISABLED=1 — refusing to dispatch\n');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /inconclusive/);
});

test('the real summary line drives the verdict: stale exits 1, fresh exits 0', () => {
  assert.equal(run(['--ledger', ledgerWith(stale)], SUMMARY).status, 1);
  assert.equal(run(['--ledger', ledgerWith(fresh)], SUMMARY).status, 0);
});

test('the empty-selection line reports idle, exit 0', () => {
  const r = run(['--ledger', ledgerWith(stale)], '[linear-drain-parked] no eligible parked issues this run.\n');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /idle/);
});

test('--eligible bypasses stdin entirely, and a bad value exits 2', () => {
  assert.equal(run(['--eligible', '0', '--ledger', ledgerWith(stale)], '').status, 0);
  assert.equal(run(['--eligible', 'nope', '--ledger', ledgerWith(stale)], '').status, 2);
});
