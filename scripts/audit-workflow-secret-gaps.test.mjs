// BRO-2378: end-to-end test of scripts/audit-workflow-secret-gaps.js against
// the real opening-night workflows. Strips every ANTHROPIC_API_KEY env line
// (the BRO-67 bug) into a temp dir and asserts the audit flags all three.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
const require = createRequire(import.meta.url);
const { findGaps } = require('./audit-workflow-secret-gaps.js');

const BRO67 = ['opening-night-checklist.yml', 'opening-night-poller.yml', 'opening-night-orchestrator.yml'];
// BRO-2378 cousin: the broadcast checklist gate runs the same checklist script.
const WORKFLOWS = [...BRO67, 'opening-night-broadcast.yml'];

function stripKey(raw, key) {
  return raw.split('\n').filter((l) => !new RegExp(`^\\s*${key}:\\s`).test(l)).join('\n');
}

// Copy workflows into a temp dir; if `strip`, remove ANTHROPIC_API_KEY env lines.
const dirs = [];
function stageBro67(strip, extra = (s) => s) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-gaps-'));
  dirs.push(dir);
  // knownSecrets is derived from the scanned dir, so keep one workflow that
  // still references secrets.ANTHROPIC_API_KEY (a stripped copy would lose it).
  fs.writeFileSync(
    path.join(dir, 'zz-known-secret.yml'),
    'name: k\non: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n        env:\n          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n',
  );
  for (const f of WORKFLOWS) {
    let raw = fs.readFileSync(path.join(WF_DIR, f), 'utf8');
    if (strip) {
      // also drop file-wide exemptions so the real consuming step is judged
      raw = stripKey(raw, 'ANTHROPIC_API_KEY').replace(/^\s*# audit-secret-gap-ok: ANTHROPIC_API_KEY\s*$/gm, '');
    }
    fs.writeFileSync(path.join(dir, f), extra(raw));
  }
  return dir;
}

test('real workflows: BRO-67 trio has no ANTHROPIC_API_KEY gaps', () => {
  const dir = stageBro67(false);
  const gaps = findGaps(dir).filter((g) => g.secret === 'ANTHROPIC_API_KEY');
  assert.deepEqual(gaps, []);
  // Bindings must be real env wiring, not a file-wide exemption comment.
  for (const f of WORKFLOWS) {
    const raw = fs.readFileSync(path.join(WF_DIR, f), 'utf8');
    assert.match(raw, /ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/, `${f} binds the key`);
    assert.doesNotMatch(raw, /audit-secret-gap-ok:\s*ANTHROPIC_API_KEY/, `${f} must not exempt the key`);
  }
});

test('flags all three BRO-67 workflows when ANTHROPIC_API_KEY is removed', () => {
  const dir = stageBro67(true);
  const gaps = findGaps(dir).filter((g) => g.secret === 'ANTHROPIC_API_KEY');
  const flagged = new Set(gaps.map((g) => g.workflow));
  for (const f of WORKFLOWS) assert.ok(flagged.has(f), `${f} should be flagged`);
  // Per-step: orchestrator + broadcast each consume the key via the checklist script.
  const steps = new Set(gaps.map((g) => `${g.workflow}::${g.script}`));
  assert.ok(steps.has('opening-night-orchestrator.yml::scripts/opening-night-checklist.js'));
  assert.ok(steps.has('opening-night-broadcast.yml::scripts/opening-night-checklist.js'));
});

test('exemption comment suppresses the flag', () => {
  const dir = stageBro67(true, (s) => `# audit-secret-gap-ok: ANTHROPIC_API_KEY\n${s}`);
  assert.deepEqual(findGaps(dir).filter((g) => g.secret === 'ANTHROPIC_API_KEY'), []);
});

test('CLI is advisory: exits 0 and emits JSON gaps for a --dir', () => {
  const dir = stageBro67(true);
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'audit-workflow-secret-gaps.js'), '--json', `--dir=${dir}`], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.ok(out.gaps.some((g) => g.secret === 'ANTHROPIC_API_KEY'));
});

after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
