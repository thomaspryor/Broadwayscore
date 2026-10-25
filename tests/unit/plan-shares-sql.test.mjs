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

// Shared Diary (BRO-4566): same harness, every share migration in order (the
// diary migration also repoints plan_shares at the shared token guard, so it
// needs the plans migrations under it).
const diaryTests = join(root, 'tests/sql/diary-shares.test.sql');
const shareMigrations = readdirSync(migDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  // Match on SQL, not comments: a later migration that only MENTIONS these
  // tables must not be applied onto the minimal stub.
  .filter((f) => /plan_shares|diary_shares|share_token_guard/.test(readFileSync(join(migDir, f), 'utf-8').replace(/--[^\n]*/g, '')))
  .map((f) => join(migDir, f));

test('diary_shares SQL assertions pass on a local Postgres', (t) => {
  assert.ok(shareMigrations.some((f) => /20261004_diary_shares\.sql$/.test(f)), 'diary migration found');
  if (!hasPostgres()) {
    if (process.env.CI) assert.fail('no PostgreSQL server binaries on this CI runner; the SQL tests did not run');
    t.skip('no local PostgreSQL server binaries (set PG_BIN to run)');
    return;
  }
  const r = spawnSync('bash', [harness, ...shareMigrations, diaryTests], { encoding: 'utf-8', timeout: 240_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, `harness failed:\n${out.slice(-3000)}`);
  assert.match(out, /all assertions passed/);
  assert.match(out, /with notes off, NO row carries a text key/, 'the notes-privacy assertion must have run');
});

// Welcome email (BRO-4620): welcome_emails table + welcome_email_candidates().
// Same harness and stub; the stub's auth.users carries the GoTrue columns the
// candidates function reads.
const welcomeTests = join(root, 'tests/sql/welcome-emails.test.sql');
const welcomeMigrations = readdirSync(migDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .filter((f) => /welcome_emails|welcome_email_candidates/.test(readFileSync(join(migDir, f), 'utf-8').replace(/--[^\n]*/g, '')))
  .map((f) => join(migDir, f));

test('welcome_emails SQL assertions pass on a local Postgres', (t) => {
  assert.ok(welcomeMigrations.some((f) => /20261004b_welcome_emails\.sql$/.test(f)), 'welcome migration found');
  if (!hasPostgres()) {
    if (process.env.CI) assert.fail('no PostgreSQL server binaries on this CI runner; the SQL tests did not run');
    t.skip('no local PostgreSQL server binaries (set PG_BIN to run)');
    return;
  }
  const r = spawnSync('bash', [harness, ...welcomeMigrations, welcomeTests], { encoding: 'utf-8', timeout: 240_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, `harness failed:\n${out.slice(-3000)}`);
  assert.match(out, /all assertions passed/);
  assert.match(out, /a second claim for the same account inserts nothing/, 'the once-only claim assertion must have run');
});

// Welcome step (BRO-4619): profiles.onboarding_seen_at + claim_onboarding().
const onboardingMigration = join(migDir, '20261005_profile_onboarding.sql');
const onboardingTests = join(root, 'tests/sql/profile-onboarding.test.sql');

test('profile onboarding SQL assertions pass on a local Postgres', (t) => {
  if (!hasPostgres()) {
    if (process.env.CI) assert.fail('no PostgreSQL server binaries on this CI runner; the SQL tests did not run');
    t.skip('no local PostgreSQL server binaries (set PG_BIN to run)');
    return;
  }
  const r = spawnSync('bash', [harness, onboardingMigration, onboardingTests], { encoding: 'utf-8', timeout: 240_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, `harness failed:\n${out.slice(-3000)}`);
  assert.match(out, /all assertions passed/);
  assert.match(out, /re-apply does not hide the welcome from new accounts/, 'the re-run assertion must have run');
  assert.match(out, /first apply backfills every existing account/, 'the backfill assertion must have run');
});
