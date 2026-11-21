// BRO-4989 Step 0: the push-core-data reconcile step warns when both sides
// changed the same commercial.json content. Runs the action's own inline
// script (extracted from the YAML, not copied: a copy would drift and prove
// nothing about the action), with its /tmp inputs pointed at a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../..');
const ACTION = fs.readFileSync(path.join(ROOT, '.github/actions/push-core-data/action.yml'), 'utf8');

function commercialReconcileScript() {
  const start = ACTION.indexOf('const { mergeCommercialJson }');
  assert.ok(start > 0, 'commercial reconcile block not found in action.yml');
  const open = ACTION.lastIndexOf("node -e '", start);
  const close = ACTION.indexOf("' 2>&1", start);
  assert.ok(open > 0 && close > start, 'could not delimit the node -e script');
  return ACTION.slice(open + "node -e '".length, close);
}

function run({ ours, remote, base }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-commercial-'));
  const p = (n) => path.join(dir, n);
  fs.writeFileSync(p('ours.json'), JSON.stringify(ours));
  fs.writeFileSync(p('remote.json'), JSON.stringify(remote));
  if (base) fs.writeFileSync(p('base.json'), JSON.stringify(base));
  const script = commercialReconcileScript()
    .replaceAll('/tmp/our-commercial.json', p('ours.json'))
    .replaceAll('/tmp/remote-commercial.json', p('remote.json'))
    .replaceAll('/tmp/base-commercial.json', p('base.json'));
  const summary = p('summary.md');
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_WORKSPACE: ROOT, GITHUB_STEP_SUMMARY: summary },
  });
  const merged = JSON.parse(fs.readFileSync(p('commercial.json'), 'utf8'));
  const sum = fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  return { out, merged, sum };
}

const rec = (extra) => ({ designation: 'Fizzle', weeklyRunningCost: 900000, lastUpdated: '2026-10-01T00:00:00Z', ...extra });

test('both sides changing the same content prints a ::warning:: and a summary line', () => {
  const base = { shows: { a: rec() } };
  const ours = { shows: { a: rec({ weeklyRunningCost: 950000, lastUpdated: '2026-10-02T00:00:00Z' }) } };
  const remote = { shows: { a: rec({ weeklyRunningCost: 1000000, lastUpdated: '2026-10-03T00:00:00Z' }) } };
  const { out, merged, sum } = run({ ours, remote, base });
  assert.match(out, /::warning::commercial\.json merge: both sides changed 1 record\(s\), newer side kept: a/);
  assert.match(sum, /both sides changed 1 record/);
  assert.equal(merged.shows.a.weeklyRunningCost, 1000000);
});

test('a model re-run on one side and a content fix on the other is not a conflict', () => {
  const base = { shows: { a: rec({ modelRecoupmentPct: [1, 2, 3], modelLastRun: '2026-10-01' }) } };
  const ours = { shows: { a: rec({ modelRecoupmentPct: [4, 5, 6], modelLastRun: '2026-10-10' }) } };
  const remote = { shows: { a: rec({ modelRecoupmentPct: [1, 2, 3], modelLastRun: '2026-10-01', weeklyRunningCost: 1000000, lastUpdated: '2026-10-10T00:00:00Z' }) } };
  const { out, merged } = run({ ours, remote, base });
  assert.doesNotMatch(out, /::warning::/);
  assert.match(out, /Reconciled commercial\.json/);
  assert.equal(merged.shows.a.weeklyRunningCost, 1000000);
});
