#!/usr/bin/env node
'use strict';

/**
 * rename-show-id.js — rename a show id across the three repos (S5-T6/S5-T8).
 *
 *   node scripts/rename-show-id.js <old-id> <new-id> [--apply]
 *        [--core-data=<dir>] [--review-texts=<dir>] [--web=<dir>]
 *        [--verbose] [--json] [--sql-only]
 *
 * Default is a DRY RUN: prints every path and key the rename would change,
 * the mentions that would remain (free text, foreign paths, unregistered
 * keys), the source files that hard-code the id, and the Supabase SQL to run
 * by hand. Nothing is written without --apply.
 *
 * --apply rewrites every registered file through the repo's write guards
 * (shows.json → shows-write-guard, commercial.json → commercial-write-guard,
 * audience-buzz.json → audience-buzz-write-guard, review files →
 * review-write-guard safeWriteReview, everything else → atomic tmp+rename),
 * `git mv`s the id-named dirs/files that git tracks (plain rename otherwise),
 * sets `aliases` on the show row (old id + its year-less slug), retires
 * nothing, and prints the SQL migration — it never runs SQL.
 *
 * Trees: --web defaults to this checkout. --core-data is the private clone
 * (~/broadway-scorecard-data); without it the core files are reached through
 * this checkout's data/ symlinks/copies exactly like every other script, and
 * the plan prints the real path of each write. --review-texts defaults to
 * this checkout's data/review-texts. A tree not given (and not reachable
 * through the checkout) is skipped, never guessed.
 *
 * Refuses when the target id already exists anywhere (shows.json id / slug /
 * alias, any registered key, any id-named path) or is retired, and when the
 * old id is missing — unless a previous --apply already renamed the row
 * (new id present with the old id in its aliases): then it resumes.
 *
 * Exit codes: 0 ok, 2 refused, 1 error.
 *
 * Registry of id-keyed files: scripts/lib/show-id-keyed-files.js.
 * Decision logic + apply: scripts/lib/show-id-rename.js.
 * Test: tests/unit/rename-show-id.test.mjs
 */

const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `Usage: node scripts/rename-show-id.js <old-id> <new-id> [--apply] [--core-data=<dir>] [--review-texts=<dir>] [--web=<dir>] [--verbose] [--json] [--sql-only]

Dry run by default: prints every path and key the rename would change across
the web checkout, the core-data clone and the review-texts repo, plus the
Supabase SQL to run by hand. --apply performs the rename (JSON rewrites through
the repo's write guards, git mv for tracked id-named dirs/files, aliases on the
show row). Never runs SQL, never retires an id.

  --apply               write (default: dry run)
  --core-data=<dir>     private core-data clone (default: reach core files through <web>/data/)
  --review-texts=<dir>  review-texts repo (default: <web>/data/review-texts)
  --web=<dir>           web checkout (default: this repo)
  --verbose             list every edit and every skipped entry
  --json                print the plan as JSON instead of text
  --sql-only            print only the Supabase migration
`;

function parseArgs(argv) {
  const positional = [];
  const flags = { apply: false, verbose: false, json: false, sqlOnly: false, coreData: null, reviewTexts: null, web: null };
  for (const a of argv) {
    if (a === '--apply') flags.apply = true;
    else if (a === '--verbose') flags.verbose = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--sql-only') flags.sqlOnly = true;
    else if (a === '--dry-run') flags.apply = false;
    else if (a.startsWith('--core-data=')) flags.coreData = a.slice('--core-data='.length);
    else if (a.startsWith('--review-texts=')) flags.reviewTexts = a.slice('--review-texts='.length);
    else if (a.startsWith('--web=')) flags.web = a.slice('--web='.length);
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else positional.push(a);
  }
  return { positional, flags };
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv) || argv.length === 0) {
    process.stdout.write(USAGE);
    process.exit(argv.length === 0 ? 1 : 0);
  }
  let parsed;
  try { parsed = parseArgs(argv); } catch (e) { console.error(e.message); process.stdout.write(USAGE); process.exit(1); }
  const { positional, flags } = parsed;
  if (positional.length !== 2) { console.error('expected exactly two positional arguments: <old-id> <new-id>'); process.stdout.write(USAGE); process.exit(1); }
  const [oldId, newId] = positional;

  const { planShowIdRename, applyShowIdRename, formatPlan, buildSqlMigration } = require('./lib/show-id-rename.js');

  if (flags.sqlOnly) {
    process.stdout.write(buildSqlMigration(oldId, newId).text);
    return;
  }

  const trees = {
    web: flags.web ? path.resolve(flags.web) : undefined,
    coreData: flags.coreData ? path.resolve(flags.coreData) : null,
    reviewTexts: flags.reviewTexts ? path.resolve(flags.reviewTexts) : null,
  };
  const plan = planShowIdRename(oldId, newId, trees);

  if (flags.json) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    process.exit(plan.ok ? 0 : 2);
  }

  console.log(flags.apply ? '=== APPLY ===' : '=== DRY RUN (nothing written; pass --apply to execute) ===');
  console.log(formatPlan(plan, { verbose: flags.verbose }));
  console.log('');
  console.log('--- Supabase migration (printed only — run it yourself after the data lands) ---');
  process.stdout.write(plan.sql.text);

  if (!plan.ok) {
    console.error(`\nrefused: ${plan.refusals.length} problem(s) above — nothing written`);
    process.exit(2);
  }
  if (!flags.apply) {
    console.log('\nnext: re-run with --apply to execute this plan.');
    return;
  }

  const result = applyShowIdRename(plan, { log: (line) => console.log(`  ${line}`) });
  console.log('');
  console.log(`applied: ${result.rewritten.length} files rewritten, ${result.moved.length} paths moved, ${result.innerRewritten.length} inner files re-stamped`);
  for (const w of result.warnings) console.warn(`  warning: ${w}`);

  // Post-apply verification: what still mentions the old id.
  const after = planShowIdRename(oldId, newId, { ...trees, scanCode: false });
  const leftovers = after.residual.filter((r) => !/slug-redirects/.test(r.path));
  if (leftovers.length) {
    console.log(`\nstill mentioning ${oldId} (${leftovers.length} files — expected for free text / foreign paths; review):`);
    for (const r of leftovers) console.log(`  ${r.path} (${r.total})`);
  }
  console.log('\nnext steps:');
  console.log('  1. node scripts/build-slug-redirects.js        # aliases -> redirects');
  console.log('  2. node scripts/rebuild-all-reviews.js         # regenerate reviews.json + public/data/shows/*');
  console.log('  3. node scripts/validate-data.js               # before pushing');
  console.log('  4. commit in each repo (web, core-data, review-texts); git mv left the review-texts moves staged');
  console.log('  5. run the Supabase migration printed above in the SQL editor');
}

main();
