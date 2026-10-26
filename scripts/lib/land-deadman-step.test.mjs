// BRO-6276: runs land.yml's real "Land the branch" script with node stubbed, to pin the deadman sizing and the
// killed-without-a-result outcome (the mutex is released by a later always() step, not here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lines = readFileSync(path.join(ROOT, '.github/workflows/land.yml'), 'utf8').split('\n');

function runBlock(stepName) {
  const i = lines.findIndex((l) => l === `      - name: ${stepName}`);
  assert.ok(i >= 0, `step ${stepName} exists`);
  const r = lines.findIndex((l, k) => k > i && /^ {8}run: \|$/.test(l));
  const out = [];
  for (let k = r + 1; k < lines.length && (lines[k] === '' || /^ {10}/.test(lines[k])); k += 1) out.push(lines[k].slice(10));
  return out.join('\n');
}

function runLand({ nodeExit, startedMinAgo = 0, startedAt, pushed = null, onMain = false }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deadman-'));
  try {
    const log = path.join(dir, 'calls.log');
    const stub = (name, body) => { writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`); chmodSync(path.join(dir, name), 0o755); };
    const marker = path.join(dir, 'pushed-sha');
    // node stands in for land.js: it writes the push marker (as landBranch does) when the case has a push.
    stub('node', `echo "node deadline=$LAND_DEADLINE_MIN marker=$LAND_PUSH_MARKER $*" >> "${log}"; ${pushed ? `echo ${pushed} > "$LAND_PUSH_MARKER";` : ''} exit ${nodeExit}`);
    stub('git', `echo "git $*" >> "${log}"; case "$1" in merge-base) exit ${onMain ? 0 : 1};; esac; exit 0`);
    stub('pkill', `echo "pkill $*" >> "${log}"; exit 0`);
    // The step script hardcodes /tmp/land-result.json; point it at this dir.
    const script = runBlock('Land the branch').replaceAll('/tmp/land-result.json', path.join(dir, 'result.json')).replaceAll('/tmp/land.log', path.join(dir, 'land.log')).replaceAll('/tmp/land-riders.json', path.join(dir, 'riders.json')).replaceAll('/tmp/land-pushed-sha', marker);
    writeFileSync(path.join(dir, 'run.sh'), `set -eo pipefail\n${script}\n`);
    const out = path.join(dir, 'out');
    const stdout = execFileSync('bash', [path.join(dir, 'run.sh')], {
      encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH}`, BRANCH: 'land/x', TIP: 'a'.repeat(40), BASE: 'b'.repeat(40), GITHUB_OUTPUT: out, LAND_JOB_STARTED_AT: startedAt ?? String(Math.floor(Date.now() / 1000) - startedMinAgo * 60) },
    });
    return { stdout, output: existsSync(out) ? readFileSync(out, 'utf8') : '', calls: existsSync(log) ? readFileSync(log, 'utf8') : '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a fresh job gets the full deadline; a hung land.js killed by timeout reports deadman and cleans up', () => {
  const r = runLand({ nodeExit: 124 });
  assert.match(r.calls, /node deadline=55 marker=\S+pushed-sha scripts\/land\.js --branch land\/x/);
  assert.match(r.stdout, /deadman: 110 min backstop/);
  assert.match(r.output, /landed=false/);
  assert.match(r.output, /failed_check=deadman/);
  assert.match(r.calls, /pkill -f scripts\/land\.js/);
});

test('a long queue wait shrinks the deadline (0 = no retry) and the backstop (never below 10)', () => {
  assert.match(runLand({ nodeExit: 124, startedMinAgo: 40 }).calls, /deadline=20 /);
  assert.match(runLand({ nodeExit: 124, startedMinAgo: 60 }).calls, /deadline=0 /, 'under 50 min left: no retry at all');
  const late = runLand({ nodeExit: 124, startedMinAgo: 105 });
  assert.match(late.calls, /deadline=0 /);
  assert.match(late.stdout, /deadman: 10 min backstop/);
});

test('an ordinary crash without a result stays fatal, and nothing is killed', () => {
  const r = runLand({ nodeExit: 1 });
  assert.match(r.output, /failed_check=fatal/);
  assert.doesNotMatch(r.calls, /pkill/);
});

test('a missing or garbled job start warns and sizes from now instead of failing the step', () => {
  for (const startedAt of ['', 'soon']) {
    const r = runLand({ nodeExit: 0, startedAt });
    assert.match(r.stdout, /::warning::LAND_JOB_STARTED_AT missing/);
    assert.match(r.calls, /node deadline=55 /);
  }
});

test('killed after a push that reached main: reported landed with the pushed sha, not refused', () => {
  const sha = 'c'.repeat(40);
  const r = runLand({ nodeExit: 124, pushed: sha, onMain: true });
  assert.match(r.output, /landed=true/);
  assert.match(r.output, new RegExp(`sha=${sha}`));
  assert.doesNotMatch(r.output, /failed_check=deadman/);
  assert.match(r.calls, /git merge-base --is-ancestor c{40} origin\/main/);
});

test('killed with a pushed sha that is NOT on main (push rejected or never sent): still deadman', () => {
  const r = runLand({ nodeExit: 137, pushed: 'd'.repeat(40), onMain: false });
  assert.match(r.output, /landed=false/);
  assert.match(r.output, /failed_check=deadman/);
});

test('an ordinary crash never consults the push marker', () => {
  const r = runLand({ nodeExit: 1, pushed: 'e'.repeat(40), onMain: true });
  assert.match(r.output, /failed_check=fatal/);
  assert.doesNotMatch(r.calls, /merge-base/);
});
