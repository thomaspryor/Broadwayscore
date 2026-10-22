import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const SH = new URL('./tsc-node-options.sh', import.meta.url).pathname;
const run = (NODE_OPTIONS) => {
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  if (NODE_OPTIONS !== undefined) env.NODE_OPTIONS = NODE_OPTIONS;
  return execFileSync('bash', [SH], { env }).toString().trim();
};

test('unset gets the 6144 floor', () => assert.equal(run(undefined), '--max-old-space-size=6144'));
test('smaller caller heap is raised, other flags kept', () =>
  assert.equal(run('--trace-warnings --max-old-space-size=2048'), '--trace-warnings --max-old-space-size=2048 --max-old-space-size=6144'));
test('larger caller heap is kept', () => assert.equal(run('--max-old-space-size=8192'), '--max-old-space-size=8192'));
test('pre-push, land-gauntlet and friction-card all use the helper', () => {
  for (const f of ['../hooks/pre-push', './land-gauntlet.sh', '../auto-fix-friction-card.js'])
    assert.match(fs.readFileSync(new URL(f, import.meta.url), 'utf8'), /tsc-node-options\.sh/, f);
  const g = fs.readFileSync(new URL('./land-gauntlet.sh', import.meta.url), 'utf8');
  assert.match(g, /^gate tsc env NODE_OPTIONS="\$TSC_NODE_OPTIONS" npx tsc/m);
  assert.match(g, /^gate tsc-llm-scoring env NODE_OPTIONS="\$TSC_NODE_OPTIONS"/m);
});
test('underscore spelling is honored when parsing', () => {
  assert.equal(run('--max_old_space_size=8192'), '--max_old_space_size=8192');
  assert.equal(run('--max_old_space_size=2048'), '--max_old_space_size=2048 --max-old-space-size=6144');
});
test('gauntlet copied alone (as land.yml does) still gets the floor', () => {
  const dir = fs.mkdtempSync('/tmp/gauntlet-copy.');
  fs.copyFileSync(new URL('./land-gauntlet.sh', import.meta.url), `${dir}/land-gauntlet.sh`);
  const sh = fs.readFileSync(`${dir}/land-gauntlet.sh`, 'utf8');
  assert.match(sh, /\|\| TSC_NODE_OPTIONS=""/);
  assert.match(sh, /\[ -n "\$TSC_NODE_OPTIONS" \] \|\| TSC_NODE_OPTIONS=".*--max-old-space-size=6144"/);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('space-separated heap flag is parsed', () => {
  assert.equal(run('--max-old-space-size 8192'), '--max-old-space-size 8192');
});
