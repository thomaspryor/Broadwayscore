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
