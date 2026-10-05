// BRO-554 acceptance wrapper: "Deploy deduplication (reduce 48 deploys/day)".
// The dedup logic is the content-aware gate in scripts/lib/should-deploy-gate.js
// (vercel-deploy.yml runs it on every cron tick). Its tests live in
// scripts/lib/should-deploy-gate.test.mjs, which CI globs; this wrapper runs that
// suite so the card's VERIFY command exercises the real gate, not a copy of it.
//
// Run: node --test scripts/vercel-deploy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('should-deploy gate suite (dedup within window, ship on change, fail open) passes', () => {
  const r = spawnSync(process.execPath, ['--test', path.join(here, 'lib', 'should-deploy-gate.test.mjs')], { encoding: 'utf8', timeout: 120000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.equal(r.status, 0, `gate tests failed:\n${out.slice(-2000)}`);
  assert.match(out, /# fail 0/);
});
