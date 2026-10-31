// Runs tests/sql/fantasy-entries.test.sql against a throwaway local Postgres
// (BRO-5424). The draft route's insert broke in April 2026 when a privacy
// migration removed anon's SELECT policy and the route still asked for the
// new row back (INSERT ... RETURNING needs SELECT): every draft failed and
// nothing noticed for months. This applies every migration that touches the
// fantasy tables, oldest first, on top of the base-table fixture, then the
// SQL assertions. Locally without Postgres it SKIPS; on CI a missing Postgres
// FAILS, so the check can't silently go dark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const harness = join(root, 'scripts/test-plan-shares-sql.sh');
const fixture = join(root, 'tests/fixtures/fantasy-entries-base.sql');
const sqlTests = join(root, 'tests/sql/fantasy-entries.test.sql');
const migDir = join(root, 'supabase/migrations');

const migrations = readdirSync(migDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  // Match on SQL, not comments: a migration that only MENTIONS the tables
  // must not be applied onto the minimal fixture.
  .filter((f) => /fantasy_entries|fantasy_leagues/.test(readFileSync(join(migDir, f), 'utf-8').replace(/--[^\n]*/g, '')))
  .map((f) => join(migDir, f));

function hasPostgres() {
  if (process.env.PG_BIN) return existsSync(join(process.env.PG_BIN, 'initdb'));
  if (spawnSync('sh', ['-c', 'command -v initdb'], { encoding: 'utf-8' }).status === 0) return true;
  const base = '/usr/lib/postgresql';
  return existsSync(base) && readdirSync(base).some((v) => existsSync(join(base, v, 'bin/initdb')));
}

test('fantasy migrations are found, oldest first, hardening last', () => {
  assert.match(migrations[0], /20260417_fantasy_leagues\.sql$/);
  assert.ok(migrations.some((f) => /20261016_fantasy_entries_insert_hardening\.sql$/.test(f)), 'hardening migration found');
});

test('fantasy_entries SQL assertions pass on a local Postgres', (t) => {
  if (!hasPostgres()) {
    if (process.env.CI) assert.fail('no PostgreSQL server binaries on this CI runner; the SQL tests did not run');
    t.skip('no local PostgreSQL server binaries (set PG_BIN to run)');
    return;
  }
  // Only migrations newer than the April 2026 chain must be re-runnable.
  const applyOnce = 1 + migrations.filter((f) => /\/2026(04|08)\d\d/.test(f)).length;
  const r = spawnSync('bash', [harness, fixture, ...migrations, sqlTests], {
    encoding: 'utf-8',
    timeout: 240_000,
    env: { ...process.env, SQL_HARNESS_APPLY_ONCE: String(applyOnce) },
  });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, `harness failed:\n${out.slice(-3000)}`);
  assert.match(out, /all assertions passed/);
  assert.match(out, /a client-supplied created_at is replaced with now\(\)/, 'the backdating assertion must have run');
});
