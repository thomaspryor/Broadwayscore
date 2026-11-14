import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { decideGauntletPlan } = require('./lib/land-gauntlet-optimizer.js');

test('bot-churn-only diff skips the whole gauntlet', () => {
  const p = decideGauntletPlan({ changedFiles: ['data/audit/x.json', 'data/pending-fixes/a.json', 'data/audit/x.jsonl', 'public/images/shows/x/poster.webp'] });
  assert.equal(p.skipGauntlet, true);
  assert.equal(p.inertOnly, true);
});

test('one code file anywhere forces the full gauntlet', () => {
  for (const f of ['src/app/page.tsx', 'scripts/foo.js', '.github/workflows/land.yml', 'package.json', 'tests/unit/a.test.mjs']) {
    assert.equal(decideGauntletPlan({ changedFiles: ['data/audit/x.json', f] }).skipGauntlet, false, f);
  }
});

test('empty/unknown diff never skips', () => {
  assert.equal(decideGauntletPlan({ changedFiles: [] }).skipGauntlet, false);
  assert.equal(decideGauntletPlan({}).skipGauntlet, false);
});

test('rollback switches force a full run', () => {
  const changedFiles = ['data/audit/x.json'];
  assert.equal(decideGauntletPlan({ changedFiles, strict: true }).skipGauntlet, false);
  assert.equal(decideGauntletPlan({ changedFiles, disabled: true }).skipGauntlet, false);
});

test('tracked data read by the gauntlet is NOT skippable', () => {
  for (const f of ['data/outlet-registry.json', 'data/awards.json', 'data/shows.json', '.cron-health-exempt.txt']) {
    assert.equal(decideGauntletPlan({ changedFiles: [f] }).skipGauntlet, false, f);
  }
});

test('docs are NOT skippable: tests read them (BRO-5648, 8aa74a7f6 landed CLOUD.md over its byte cap through a skipped gauntlet)', () => {
  for (const f of ['.claude/CLOUD.md', 'AGENTS.md', 'CLAUDE.md', '.claude/commands/ship-check.md', 'docs/notion-linear-residue-sweep.md', 'docs/cloud-routines/board-workers.md', 'memory/hooks-audit.md', 'cloud-memory/MEMORY.md', 'sprint-plan-x.md']) {
    assert.equal(decideGauntletPlan({ changedFiles: ['data/audit/x.json', f] }).skipGauntlet, false, f);
  }
});

test('land.yml wires the plan into the expensive steps', () => {
  const y = readFileSync(new URL('../.github/workflows/land.yml', import.meta.url), 'utf8');
  const checks = y.slice(y.indexOf('\n  checks:'), y.indexOf('\n  land:'));
  const blocks = checks.split('\n      - ').slice(1);
  assert.match(checks, /id: plan/);
  for (const id of ['deps', 'coredata', 'manifests', 'actionlint', 'harness', 'basekey', 'base_cache', 'base_artifact', 'base_run', 'branch_run', 'delta', 'tipkey']) {
    const b = blocks.find((x) => new RegExp(`\\n        id: ${id}\\n`).test(x + '\n'));
    assert.ok(b, `step ${id} exists`);
    assert.match(b, /if:[^\n]*steps\.plan\.outputs\.skip_gauntlet != 'true'/, `step ${id} must be gated on skip_gauntlet`);
  }
});
