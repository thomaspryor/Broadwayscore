#!/usr/bin/env node
// Verifies every committed Supabase migration has actually been applied to
// prod: derives expected schema objects from supabase/migrations/*.sql
// (scripts/lib/supabase-schema-expectations.js) and diffs them against the
// live catalog via the Management API. Each missing object prints the exact
// apply-migration.yml command that fixes it.
//
// Why: migrations are applied deliberately (apply-migration.yml, manual
// dispatch) — a committed-but-unapplied migration used to surface only when
// the nightly UGC roundtrip 400'd on the missing column (incident 2026-08-09,
// watchlist.curtain_time, run 31344422375).
//
// Callers: .github/workflows/verify-schema.yml (push on supabase/migrations/**
// + weekly cron), .github/workflows/supabase-functions.yml (pre-deploy gate).
//
// Usage:
//   node scripts/verify-supabase-schema.js               # full check (needs env)
//   node scripts/verify-supabase-schema.js --parse-only  # print derived assertions, no network
// Env: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF

'use strict';

const fs = require('fs');
const path = require('path');
const {
  deriveExpectations,
  diffAgainstLive,
  LIVE_CATALOG_QUERY,
} = require('./lib/supabase-schema-expectations');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const PARSE_ONLY = process.argv.includes('--parse-only');

async function queryLiveCatalog() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = process.env.SUPABASE_PROJECT_REF;
  if (!token || !ref) {
    console.error('::error::SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required (or use --parse-only)');
    process.exit(1);
  }
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: LIVE_CATALOG_QUERY }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Distinguish "cannot check" from "checked and missing": an API outage
    // must fail the job (loud) rather than pass vacuously.
    console.error(`::error::Management API query failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    process.exit(1);
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length < 10) {
    console.error(`::error::catalog query returned ${Array.isArray(rows) ? rows.length : 'non-array'} rows — refusing a vacuous pass`);
    process.exit(1);
  }
  return rows;
}

async function main() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
  if (files.length === 0) {
    console.error('::error::no migration files found — wrong checkout?');
    process.exit(1);
  }

  const { expected, skipped, errors } = deriveExpectations(files);
  console.log(`Derived ${expected.size} schema assertions from ${files.length} migrations` +
    (skipped.length ? ` (skipped by annotation: ${skipped.join(', ')})` : ''));

  for (const err of errors) console.error(`::error::${err}`);

  if (PARSE_ONLY) {
    const byFile = {};
    for (const { kind, name, file } of expected.values()) {
      (byFile[file] ||= []).push(`${kind} ${name}`);
    }
    for (const [file, items] of Object.entries(byFile)) {
      console.log(`\n${file}`);
      for (const item of items.sort()) console.log(`  ${item}`);
    }
    process.exit(errors.length ? 1 : 0);
  }

  if (errors.length) process.exit(1);

  const liveRows = await queryLiveCatalog();
  const missing = diffAgainstLive(expected, liveRows);

  if (missing.length === 0) {
    console.log(`✓ all ${expected.size} expected objects exist in prod`);
    return;
  }

  const byMigration = {};
  for (const obj of missing) (byMigration[obj.file] ||= []).push(obj);
  for (const [file, objs] of Object.entries(byMigration)) {
    for (const { kind, name } of objs) {
      console.error(`::error::missing in prod: ${kind} ${name} (declared by ${file})`);
    }
    console.error(
      `::error::apply it: gh workflow run apply-migration.yml -f migration=supabase/migrations/${file} -f confirm=APPLY`
    );
  }
  process.exit(1);
}

main().catch((err) => {
  console.error(`::error::${err.stack || err}`);
  process.exit(1);
});
