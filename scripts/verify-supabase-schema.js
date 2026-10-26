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
  diffFunctionBodies,
  findUnexpectedPolicies,
  findUndeletedUserTables,
  liveSiblings,
  LIVE_CATALOG_QUERY,
} = require('./lib/supabase-schema-expectations');
const DELETE_ACCOUNT_EXEMPT = require('./lib/delete-account-exempt');

// BRO-4532: policies that exist on prod with no web migration behind them, and
// why that is expected. All are the original base schema, created in the
// dashboard before supabase/migrations existed (reviewed 2026-10-12, verify-schema
// run 38218941990). Each is pinned by policyDefHash() of its live definition, so
// a later change to one (say USING (true)) warns again. Anything else live-only
// is printed as a warning.
const KNOWN_LIVE_ONLY_POLICIES = {
  "list_items:Anyone can view public list items": { def: 'e1025ac65634', why: 'base schema: owner CRUD via lists.user_id; public read only when the parent list is_public' },
  "list_items:Users can CRUD own list items": { def: '910d7235268c', why: 'base schema: owner CRUD via lists.user_id; public read only when the parent list is_public' },
  "lists:Anyone can view public lists": { def: '9a79e1181110', why: 'base schema: owner CRUD; public read only when is_public' },
  "lists:Users can CRUD own lists": { def: '6c381405dcc8', why: 'base schema: owner CRUD; public read only when is_public' },
  "profiles:Anyone can view public list owner profiles": { def: '32a3fabb8f51', why: 'base schema: own row only; public read limited to owners of public lists' },
  "profiles:Users can insert own profile": { def: 'd3ccd199a78e', why: 'base schema: own row only; public read limited to owners of public lists' },
  "profiles:Users can read own profile": { def: 'b4c3da844dbe', why: 'base schema: own row only; public read limited to owners of public lists' },
  "profiles:Users can update own profile": { def: '3d1bf21b00f0', why: 'base schema: own row only; public read limited to owners of public lists' },
  "push_log:Service role only": { def: 'f3eb6b0cc54c', why: 'base schema: service_role only' },
  "push_tokens:Service role can read all tokens": { def: '5211d8a938ee', why: 'base schema: service_role read (iOS push sender)' },
  "reviews:Users can delete own reviews": { def: '995c7cfd49f3', why: 'base schema: own rows only (auth.uid() = user_id)' },
  "reviews:Users can insert own reviews": { def: 'ed1efb1ea29d', why: 'base schema: own rows only (auth.uid() = user_id)' },
  "reviews:Users can read own reviews": { def: 'a278350523dc', why: 'base schema: own rows only (auth.uid() = user_id)' },
  "reviews:Users can update own reviews": { def: '096635213bde', why: 'base schema: own rows only (auth.uid() = user_id)' },
  "user_review_photos:delete own photos": { def: '995c7cfd49f3', why: 'base schema: own rows only (auth.uid() = user_id)' },
  "user_review_photos:insert own photos": { def: 'ed1efb1ea29d', why: 'base schema: own rows only (auth.uid() = user_id)' },
  "user_review_photos:select own photos": { def: 'a278350523dc', why: 'base schema: own rows only (auth.uid() = user_id)' },
  "user_review_photos:update own photos": { def: '5981b7fcfc73', why: 'base schema: own rows only (auth.uid() = user_id)' },
  "watchlist:Users can delete own watchlist": { def: '995c7cfd49f3', why: 'base schema: own rows only (auth.uid() = user_id)' },
  "watchlist:Users can insert own watchlist": { def: 'ed1efb1ea29d', why: 'base schema: own rows only (auth.uid() = user_id)' },
  "watchlist:Users can read own watchlist": { def: 'a278350523dc', why: 'base schema: own rows only (auth.uid() = user_id)' },
  "watchlist:Users can update own watchlist": { def: '096635213bde', why: 'base schema: own rows only (auth.uid() = user_id)' },
};
const DELETE_ACCOUNT_FN = path.join(__dirname, '..', 'supabase', 'functions', 'delete-account', 'handler.mjs');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`verify-supabase-schema — fail loud when a committed migration is not applied to prod

Usage:
  node scripts/verify-supabase-schema.js               full check (queries the live catalog)
  node scripts/verify-supabase-schema.js --parse-only  print derived assertions, no network

Env: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF (full check only)`);
  process.exit(0);
}

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
  const drifted = diffFunctionBodies(expected, liveRows);
  const bodiesChecked = [...expected.values()].filter((o) => o.bodyHash).length;

  // Advisory reports (warnings only, BRO-4532 / BRO-4534; §19: advisory first).
  for (const p of findUnexpectedPolicies(expected, liveRows, KNOWN_LIVE_ONLY_POLICIES)) {
    const what = p.changed ? 'allowlisted live-only policy CHANGED definition' : 'policy on prod that no migration declares';
    console.log(`::warning::${what}: ${p.name} [def ${p.defHash}] = ${JSON.stringify(p.definition)} (drop it, add a migration, or pin it in KNOWN_LIVE_ONLY_POLICIES with a reason)`);
  }
  const fnSource = fs.existsSync(DELETE_ACCOUNT_FN) ? fs.readFileSync(DELETE_ACCOUNT_FN, 'utf8') : '';
  for (const t of findUndeletedUserTables(liveRows, fnSource, DELETE_ACCOUNT_EXEMPT)) {
    console.log(`::warning::per-user table ${t} survives account deletion: not in delete-account/handler.mjs, no cascade from auth.users/profiles, not in scripts/lib/delete-account-exempt.js`);
  }

  if (missing.length === 0 && drifted.length === 0) {
    console.log(`✓ all ${expected.size} expected objects exist in prod (${bodiesChecked} function bodies match)`);
    return;
  }

  // A body-only CREATE OR REPLACE FUNCTION never changes what exists, so it
  // would pass the existence check while unapplied (UGC roundtrip page, Oct 2026).
  for (const { name, file } of drifted) {
    console.error(`::error::function body drift: ${name} in prod differs from the latest definition in ${file}`);
    // Re-applies the whole file: check it is idempotent, or reconcile by hand
    // if prod's body was hotfixed on purpose.
    console.error(
      `::error::re-apply or reconcile: gh workflow run apply-migration.yml -f migration=supabase/migrations/${file} -f confirm=APPLY`
    );
  }

  const byMigration = {};
  for (const obj of missing) (byMigration[obj.file] ||= []).push(obj);
  for (const [file, objs] of Object.entries(byMigration)) {
    for (const obj of objs) {
      const live = ['fnconfig', 'viewopt', 'fnresult'].includes(obj.kind) ? liveSiblings(obj, liveRows) : null;
      const has = live ? ` (prod has: ${live.length ? live.join(' | ') : 'none'})` : '';
      console.error(`::error::missing in prod: ${obj.kind} ${obj.name} (declared by ${file})${has}`);
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
