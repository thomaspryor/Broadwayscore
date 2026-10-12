// BRO-5196: the Land job's first step ("Admit to the landing queue") parks a
// run behind a deep landing queue by cancelling it, so no runner sleep-polls.
// These tests execute the REAL `run:` block from land.yml with stubbed git/gh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const m = require('./land-mutex.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const yml = readFileSync(path.join(ROOT, '.github/workflows/land.yml'), 'utf8');

/** The `run: |` body of the named step in the land job. */
function runBlock(stepName) {
  const lines = yml.slice(yml.indexOf('\n  land:\n')).split('\n');
  const i = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.ok(i >= 0, `step ${stepName} exists in the land job`);
  const r = lines.findIndex((l, k) => k > i && /^ {8}run: \|$/.test(l));
  const out = [];
  for (let k = r + 1; k < lines.length && (lines[k] === '' || /^ {10}/.test(lines[k])); k += 1) out.push(lines[k].slice(10));
  return out.join('\n');
}

function runAdmit({ branch = 'land/bro-1', tickets = 0, staleTickets = 0, lsFails = false, cancelFails = false, env = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'admit-'));
  try {
    const log = path.join(dir, 'calls.log');
    const mk = (n, ageMs, off) => Array.from({ length: n }, (_, i) => `sha${off + i}\trefs/land-mutex/queue/1-${String(Date.now() - ageMs + i).padStart(13, '0')}-${100 + off + i}-1`);
    const ls = [...mk(tickets, 60000, 0), ...mk(staleTickets, 3 * 3600e3, 500)].join('\n');
    const stub = (name, body) => { writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`); chmodSync(path.join(dir, name), 0o755); };
    writeFileSync(path.join(dir, 'ls.txt'), ls ? `${ls}\n` : '');
    stub('git', `echo "git $*" >> "${log}"; ${lsFails ? 'exit 1' : `cat "${dir}/ls.txt"`}`);
    stub('gh', `echo "gh $*" >> "${log}"; ${cancelFails ? 'exit 1' : 'exit 0'}`);
    stub('sleep', `echo "sleep $*" >> "${log}"`);
    writeFileSync(path.join(dir, 'run.sh'), `set -eo pipefail\n${runBlock(m.PARK_STEP_NAME)}\n`);
    const out = execFileSync('bash', [path.join(dir, 'run.sh')], {
      encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH}`, BRANCH: branch, GH_TOKEN: 'tok', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '777', ...env },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
    return { out, cancelled: /gh api -X POST repos\/o\/r\/actions\/runs\/777\/cancel/.test(calls), calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the admit step name in land.yml is the marker land-mutex.js looks for, and it is the first step', () => {
  const land = yml.slice(yml.indexOf('\n  land:\n'));
  assert.equal(land.match(/\n {6}- name: (.+)\n/)[1], m.PARK_STEP_NAME);
});

test('a queue below the park depth proceeds without cancelling', () => {
  assert.equal(runAdmit({ tickets: m.PARK_DEPTH - 1 }).cancelled, false);
});

test('a queue at the park depth cancels the run (parks) and waits to be killed', () => {
  const r = runAdmit({ tickets: m.PARK_DEPTH });
  assert.equal(r.cancelled, true);
  assert.match(r.calls, /sleep 600/);
  assert.equal(runAdmit({ tickets: 14 }).cancelled, true);
});

test('leaked tickets older than the park window do not count toward the depth', () => {
  assert.equal(runAdmit({ tickets: 2, staleTickets: 20 }).cancelled, false);
  assert.equal(runAdmit({ tickets: 4, staleTickets: 20 }).cancelled, true);
});

test('a main-red fix lane never parks, however deep the queue', () => {
  assert.equal(runAdmit({ branch: 'land/main-red-bro-5079', tickets: 14 }).cancelled, false);
  assert.equal(runAdmit({ branch: 'land/BRO-5079-Main-Red', tickets: 14 }).cancelled, false);
});

test('fails open: unreadable queue, refused cancel, kill switches', () => {
  assert.equal(runAdmit({ tickets: 14, lsFails: true }).cancelled, false);
  const refused = runAdmit({ tickets: 14, cancelFails: true });
  assert.match(refused.out, /could not cancel this run/);
  assert.equal(runAdmit({ tickets: 14, env: { LAND_MUTEX_DISABLED: 'true' } }).cancelled, false);
  assert.equal(runAdmit({ tickets: 14, env: { LAND_MUTEX_PARK_DEPTH: '0' } }).cancelled, false);
});

test('LAND_MUTEX_PARK_DEPTH overrides the default depth', () => {
  assert.equal(runAdmit({ tickets: 6, env: { LAND_MUTEX_PARK_DEPTH: '8' } }).cancelled, false);
  assert.equal(runAdmit({ tickets: 8, env: { LAND_MUTEX_PARK_DEPTH: '8' } }).cancelled, true);
});

test('the always() steps are skipped for a parked run, so it leaves no completed work step', () => {
  const land = yml.slice(yml.indexOf('\n  land:\n'), yml.indexOf('\n  alert-red:\n'));
  const always = land.match(/^ {8}if: always\(\).*$/gm) || [];
  assert.ok(always.length >= 2);
  for (const l of always) assert.match(l, /steps\.admit\.outcome == 'success'/);
});
