// Runs tests/sql/plan-shares.test.sql against a throwaway local Postgres on
// every CI run (BRO-4481 follow-up).
//
// The harness (scripts/test-plan-shares-sql.sh) existed but nothing ran it, so
// the shipped "VOLATILE refuses GET" assumption was only ever checked live,
// after apply, by test-ugc-roundtrip.yml. This applies EVERY migration that
// mentions plan_shares / get_shared_plans, in filename order (so a later
// CREATE OR REPLACE is always the one under test), then the SQL assertions.
//
// GitHub's ubuntu runners ship PostgreSQL server binaries; the harness finds
// them under /usr/lib/postgresql/*/bin. Locally without Postgres this SKIPS;
// on CI a missing Postgres FAILS, so the check can't silently go dark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const harness = join(root, 'scripts/test-plan-shares-sql.sh');
const sqlTests = join(root, 'tests/sql/plan-shares.test.sql');
const migDir = join(root, 'supabase/migrations');

const migrations = readdirSync(migDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .filter((f) => /plan_shares|get_shared_plans/.test(readFileSync(join(migDir, f), 'utf-8')))
  .map((f) => join(migDir, f));

function hasPostgres() {
  if (process.env.PG_BIN) return existsSync(join(process.env.PG_BIN, 'initdb'));
  if (spawnSync('sh', ['-c', 'command -v initdb'], { encoding: 'utf-8' }).status === 0) return true;
  const base = '/usr/lib/postgresql';
  return existsSync(base) && readdirSync(base).some((v) => existsSync(join(base, v, 'bin/initdb')));
}

test('plan_shares migrations are found, oldest first', () => {
  assert.ok(migrations.length >= 2, `expected 20261001 + 20261002, got ${migrations.length}`);
  assert.match(migrations[0], /20261001_plan_shares\.sql$/);
});

test('plan_shares SQL assertions pass on a local Postgres', (t) => {
  if (!hasPostgres()) {
    if (process.env.CI) assert.fail('no PostgreSQL server binaries on this CI runner; the SQL tests did not run');
    t.skip('no local PostgreSQL server binaries (set PG_BIN to run)');
    return;
  }
  const r = spawnSync('bash', [harness, ...migrations, sqlTests], { encoding: 'utf-8', timeout: 240_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, `harness failed:\n${out.slice(-3000)}`);
  assert.match(out, /all assertions passed/);
  assert.match(out, /refused with SQLSTATE 25006/, 'the read-only (GET) refusal assertion must have run');
});
