/**
 * BRO-6639: GITHUB_TOKEN cannot read repo Actions variables (403), and the
 * orchestrator's `|| PAUSED=""` turned that into "not paused" (pause + Express
 * lease ignored). Two guards:
 *  1. scripts/lib/read-actions-variable.sh reports a failed read (exit 3), never
 *     as an unset variable; only HTTP 404 means unset.
 *  2. Workflow-shape: every read of ORCHESTRATOR_PAUSED / LANE_STANDDOWN in
 *     .github/workflows runs under REVIEW_TEXTS_TOKEN.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER = path.join(ROOT, 'scripts/lib/read-actions-variable.sh');
const WF_DIR = path.join(ROOT, '.github/workflows');

function runWithFakeGh({ stdout = '', stderr = '', code = 0 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
  const gh = path.join(dir, 'gh');
  fs.writeFileSync(gh, `#!/usr/bin/env bash\nprintf '%s' ${JSON.stringify(stdout)}\nprintf '%s' ${JSON.stringify(stderr)} >&2\nexit ${code}\n`, { mode: 0o755 });
  const r = spawnSync('bash', [HELPER, 'ORCHESTRATOR_PAUSED'], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r' },
    encoding: 'utf8',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

describe('read-actions-variable.sh', () => {
  test('existing variable: prints value, exit 0', () => {
    const r = runWithFakeGh({ stdout: 'express' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, 'express');
  });
  test('404: unset, exit 0, empty stdout', () => {
    const r = runWithFakeGh({ stderr: 'gh: Not Found (HTTP 404)', code: 1 });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  });
  test('403 (GITHUB_TOKEN has no variables scope): UNKNOWN exit 3 + warning, not unpaused', () => {
    const r = runWithFakeGh({ stderr: 'gh: Resource not accessible by integration (HTTP 403)', code: 1 });
    assert.strictEqual(r.status, 3);
    assert.strictEqual(r.stdout, '');
    assert.match(r.stderr, /::warning::.*UNKNOWN/);
  });
  test('5xx / network error also UNKNOWN', () => {
    const r = runWithFakeGh({ stderr: 'gh: Bad Gateway (HTTP 502)', code: 1 });
    assert.strictEqual(r.status, 3);
  });
});

describe('workflow shape: pause/standdown variable reads use REVIEW_TEXTS_TOKEN', () => {
  const READ = /actions\/variables\/(ORCHESTRATOR_PAUSED|LANE_STANDDOWN)\b|read-actions-variable\.sh/;
  const offenders = [];
  let reads = 0;
  for (const f of fs.readdirSync(WF_DIR).filter((n) => /\.ya?ml$/.test(n))) {
    const lines = fs.readFileSync(path.join(WF_DIR, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*#/.test(line) || !READ.test(line)) return;
      if (/\bgh variable (delete|set)\b/.test(line)) {
        // writes need variables scope too: an inline override must be VARS_TOKEN, or the step token REVIEW_TEXTS_TOKEN
        const inline = line.match(/GH_TOKEN=("?)([^\s"]+)\1\s+gh variable/);
        if (inline && inline[2] !== '$VARS_TOKEN') offenders.push(`${f}:${i + 1} (inline write token ${inline[2]})`);
        return;
      }
      reads++;
      {
        const inline = line.match(/GH_TOKEN=("?)([^\s"]+)\1\s+(bash|gh)\b/);
        if (inline && inline[2] !== '$VARS_TOKEN' && !inline[2].includes('REVIEW_TEXTS_TOKEN')) {
          offenders.push(`${f}:${i + 1} (inline read token ${inline[2]})`);
          return;
        }
      }
      if (line.includes('REVIEW_TEXTS_TOKEN')) return;
      if (line.includes('GH_TOKEN="$VARS_TOKEN"')) {
        // inline override: the enclosing step must define VARS_TOKEN from REVIEW_TEXTS_TOKEN
        let ok = false;
        for (let j = i; j >= 0 && !/^\s*-\s+name:/.test(lines[j]); j--) {
          if (/^\s*VARS_TOKEN:.*REVIEW_TEXTS_TOKEN/.test(lines[j])) ok = true;
        }
        if (ok) return;
      }
      // Walk back to the enclosing step and take its nearest GH_TOKEN env.
      let tok = null;
      for (let j = i; j >= 0; j--) {
        if (/^\s*-\s+name:/.test(lines[j])) break;
        const m = lines[j].match(/^\s*GH_TOKEN:\s*(.*)$/);
        if (m) { tok = m[1]; break; }
      }
      if (!tok || !tok.includes('REVIEW_TEXTS_TOKEN')) offenders.push(`${f}:${i + 1} (GH_TOKEN=${tok})`);
    });
  }
  test('found reads to check (guards against a broken regex)', () => {
    assert.ok(reads >= 5, `expected >=5 reads, found ${reads}`);
  });
  test('polling loop falls back to the job-start snapshot on a failed read', () => {
    const wf = fs.readFileSync(path.join(WF_DIR, 'opening-night-orchestrator.yml'), 'utf8');
    assert.match(wf, /PAUSED_SNAPSHOT: \$\{\{ vars\.ORCHESTRATOR_PAUSED \}\}/);
    assert.match(wf, /read-actions-variable\.sh ORCHESTRATOR_PAUSED\) \|\| \{[\s\S]*PAUSED="\$PAUSED_SNAPSHOT"/);
    assert.match(wf, /if \[ "\$READ_OK" = "1" \]; then\s+GH_TOKEN="\$VARS_TOKEN" gh variable delete ORCHESTRATOR_PAUSED/);
    assert.doesNotMatch(wf, /PAUSED=\$\(gh api repos[^\n]*ORCHESTRATOR_PAUSED[^\n]*\|\| PAUSED=""/);
  });
  test('no read runs under GITHUB_TOKEN', () => {
    assert.deepStrictEqual(offenders, []);
  });
});
