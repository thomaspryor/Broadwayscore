// LIVE-DATA-LANE: spawns scripts/landed-change-proof-audit.js, which reads data/shows.json, data/reviews.json and data/audit/landed-change-proof.jsonl. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-8111).
// BRO-8111: the CLI smoke of the landed-change proof audit, split out of landed-change-proof.test.mjs so that file stays pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('CLI smoke: a dry run over no matching commits reads git, writes nothing, exits 0', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  if (spawnSync('git', ['rev-parse', '--verify', '-q', 'origin/main'], { cwd: root }).status !== 0) return t.skip('no origin/main in this checkout');
  // BRO-8111: 2s on a quiet box, but it ran inside an 800s test gauntlet on a loaded runner and once hit the old 60s
  // cap (a kill leaves status null and empty stderr, so the failure said nothing). Generous cap, and a kill is named.
  const CAP_MS = 150000;
  const why = (x) => `${x.error ? x.error.message : ''} signal=${x.signal} status=${x.status} stderr=${x.stderr}`;
  const r = spawnSync('node', ['scripts/landed-change-proof-audit.js', '--dry-run', '--days=1', '--sha=ffffffffffff'], { cwd: root, encoding: 'utf8', timeout: CAP_MS, env: { ...process.env, GH_TOKEN: '', VERCEL_TOKEN: '' } });
  assert.equal(r.status, 0, why(r));
  assert.match(r.stdout, /all: 0 code commits/);
  assert.match(r.stdout, /dry run: would append 0 row\(s\) \+ run marker, card for 0 change\(s\)/);
  const v = spawnSync('node', ['scripts/landed-change-proof-audit.js', '--dry-run', '--sha=ffffffffffff', '--expect-proven'], { cwd: root, encoding: 'utf8', timeout: CAP_MS, env: { ...process.env, GH_TOKEN: '', VERCEL_TOKEN: '' } });
  assert.equal(v.status, 1, why(v) + ' a card VERIFY over a sha that is not on main must fail, not pass on zero rows');
});


test('CLI smoke keeps a loaded-runner timeout and names a kill (BRO-8111 class guard)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  const a = src.indexOf("test('CLI smoke:"), b = src.indexOf("test('CLI smoke keeps");
  assert.ok(a >= 0 && b > a, 'smoke test and its guard must both exist');
  const smoke = src.slice(a, b);
  assert.ok(src.indexOf("test('CLI smoke:") >= 0 && smoke.length > 100, 'guard slice must find the smoke test');
  const cap = Number((smoke.match(/const CAP_MS = (\d+)/) || [])[1]);
  assert.ok(cap >= 120000 && cap <= 200000, 'two sequential spawns must fit the 800s land gauntlet: cap 120s-200s, a 60s cap flaked once');
  assert.doesNotMatch(smoke, /timeout:\s*\d/, 'spawn timeouts must use CAP_MS');
  assert.match(smoke, /signal=\$\{x\.signal\}/, 'a killed child must say so, not fail with an empty stderr');
});
