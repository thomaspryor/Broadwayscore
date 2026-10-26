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

function runLand({ nodeExit, startedMinAgo = 0, startedAt }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deadman-'));
  try {
    const log = path.join(dir, 'calls.log');
    const stub = (name, body) => { writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`); chmodSync(path.join(dir, name), 0o755); };
    stub('node', `echo "node deadline=$LAND_DEADLINE_MIN $*" >> "${log}"; exit ${nodeExit}`);
    stub('pkill', `echo "pkill $*" >> "${log}"; exit 0`);
    // The step script hardcodes /tmp/land-result.json; point it at this dir.
    const script = runBlock('Land the branch').replaceAll('/tmp/land-result.json', path.join(dir, 'result.json')).replaceAll('/tmp/land.log', path.join(dir, 'land.log')).replaceAll('/tmp/land-riders.json', path.join(dir, 'riders.json'));
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
  assert.match(r.calls, /node deadline=55 scripts\/land\.js --branch land\/x/);
  assert.match(r.stdout, /deadman: 110 min backstop/);
  assert.match(r.output, /landed=false/);
  assert.match(r.output, /failed_check=deadman/);
  assert.match(r.calls, /pkill -f scripts\/land\.js/);
});

test('a long queue wait shrinks the deadline (never below 5) and the backstop (never below 10)', () => {
  assert.match(runLand({ nodeExit: 124, startedMinAgo: 40 }).calls, /deadline=20 /);
  const late = runLand({ nodeExit: 124, startedMinAgo: 105 });
  assert.match(late.calls, /deadline=5 /);
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
