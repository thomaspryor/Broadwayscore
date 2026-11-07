// BRO-3688: every lint-workflow-guards.sh check that globs .github/workflows
// must fail closed on a near-empty/wrong dir instead of reporting clean after
// scanning nothing (same class as BRO-3684/3686, via bash glob expansion).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GUARD = path.join(REPO, 'scripts/lint-workflow-guards.sh');
const src = readFileSync(GUARD, 'utf8');
const CHECKS = [...src.matchAll(/workflow_yml_files_or_fail (check_[a-z_]+) \|\| return/g)].map((m) => m[1]);

test('no check iterates the raw workflow glob any more', () => {
  assert.doesNotMatch(src, /^\s*for f in \.github\/workflows\/\*\.yml; do/m);
});

test('all 8 glob-scanning checks are wired to the floor helper', () => {
  assert.deepEqual(CHECKS.sort(), [
    'check_core_data_pairing', 'check_dry_run_flag_setter', 'check_prebuild',
    'check_private_git_add', 'check_scraping_fallback', 'check_scrapingdog_pairing',
    'check_snapshot_overwrite', 'check_theatr_token',
  ]);
});

test('an empty workflow dir makes every glob check refuse a verdict', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wf-empty-'));
  const r = spawnSync('bash', [GUARD], { cwd: REPO, env: { ...process.env, WF_DIR: dir }, encoding: 'utf8' });
  const out = r.stdout + r.stderr;
  for (const c of CHECKS) assert.match(out, new RegExp(`::error::${c} found only 0 workflow file`), c);
  assert.notEqual(r.status, 0);
});

test('the real workflow tree clears the floor (no false refusals)', () => {
  const r = spawnSync('bash', [GUARD], { cwd: REPO, encoding: 'utf8' });
  assert.doesNotMatch(r.stdout + r.stderr, /found only \d+ workflow file\(s\) in \.github\/workflows/);
});
