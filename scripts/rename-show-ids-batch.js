#!/usr/bin/env node
'use strict';

/**
 * rename-show-ids-batch.js — rename a batch of show ids whose market suffix
 * disagrees with their category (BRO-4315, 2026 data audit S8-T1), driven by
 * .github/workflows/rename-show-ids.yml against the real three trees.
 *
 *   node scripts/rename-show-ids-batch.js --batch=data/show-id-renames/<name>.json
 *        --core-data=<clone> --review-texts=<dir> [--web=<dir>] [--apply | --check]
 *
 * Batch file: { card, reason, renames: [{ oldId, newId, expectTitle }] }, at
 * most 25 pairs. Each pair must turn a mismatched id into a matching one
 * (scripts/lib/show-id-market-suffix.js), so the batch file cannot be used
 * for any other kind of rename.
 *
 * Default is a dry run of every pair. --apply plans EVERY pair first and
 * writes nothing if any pair refuses; then applies them one by one through
 * scripts/lib/show-id-rename.js (re-planned right before each apply, since an
 * earlier pair rewrites shared files like related-shows.json); then re-plans
 * each pair and fails unless nothing is left to change. The workflow pushes
 * only when this exits 0, so a failure leaves every repo untouched.
 *
 * A pair whose shows.json row is already renamed (new id row carrying the old
 * id in `aliases`) resumes: a rerun after a push that died between repos
 * finishes the remaining files. If push-core-data's 3-way merge brought the
 * old row back beside it (a concurrent writer edited that row), the rerun
 * drops the old row again ('reappeared') and resumes; that writer's edit is
 * lost and its next run redoes it.
 *
 * Slugs: the row keeps its slug unless slug === old id (7 of the BRO-4315
 * rows); then the slug becomes the new id and the old one survives as an
 * alias, so the old URL still 301s.
 *
 * --check runs only that last step: every pair fully renamed in all three
 * trees (no old-id row, exactly one new-id row with the old id in aliases,
 * its slug unique, nothing left to rewrite or move). The workflow runs it
 * after the pushes, against trees rebased onto origin: push-core-data's 3-way
 * merge can re-add a row a concurrent writer edited, and a web writer that
 * pushes after us from a pre-rename checkout can put old ids back.
 *
 * Exit codes: 0 ok, 2 refused (nothing written), 1 failed.
 */

const fs = require('fs');
const path = require('path');
const { marketSuffixMismatch } = require('./lib/show-id-market-suffix.js');

const MAX_PAIRS = 25;

/** Problems with the batch file itself (shape, size, suffix rule). */
function batchProblems(batch) {
  const out = [];
  if (!batch || typeof batch !== 'object') return ['batch file is not an object'];
  if (typeof batch.card !== 'string' || !/^BRO-\d+$/.test(batch.card)) out.push('card must be a Linear id like BRO-4315');
  if (typeof batch.reason !== 'string' || !batch.reason.trim()) out.push('reason is required');
  const pairs = batch.renames;
  if (!Array.isArray(pairs) || !pairs.length) return [...out, 'renames must be a non-empty array'];
  if (pairs.length > MAX_PAIRS) out.push(`at most ${MAX_PAIRS} renames per batch (got ${pairs.length})`);
  const seen = new Set();
  for (const [i, p] of pairs.entries()) {
    const at = `renames[${i}]`;
    if (!p || typeof p.oldId !== 'string' || typeof p.newId !== 'string' || typeof p.expectTitle !== 'string' || !p.expectTitle) {
      out.push(`${at}: oldId, newId and expectTitle are required strings`);
      continue;
    }
    for (const id of [p.oldId, p.newId]) {
      if (seen.has(id)) out.push(`${at}: ${id} appears twice in the batch`);
      seen.add(id);
    }
  }
  return out;
}

/**
 * Where one pair stands in a shows.json: 'pending' (old row, title matches),
 * 'resume' (already renamed: new row with the old id in aliases), or a problem.
 */
function pairState(pair, shows) {
  const oldRow = shows.find((s) => s && s.id === pair.oldId);
  const newRow = shows.find((s) => s && s.id === pair.newId);
  const row = newRow || oldRow;
  if (!row) return { problem: `${pair.oldId}: no row under the old or the new id` };
  const reappeared = Boolean(oldRow && newRow && Array.isArray(newRow.aliases) && newRow.aliases.includes(pair.oldId));
  if (oldRow && newRow && !reappeared) return { problem: `${pair.oldId}: both ${pair.oldId} and ${pair.newId} rows exist (a merge, not a rename)` };
  if (row.title !== pair.expectTitle) return { problem: `${pair.oldId}: title is "${row.title}", batch expected "${pair.expectTitle}"` };
  if (!marketSuffixMismatch({ id: pair.oldId, category: row.category })) return { problem: `${pair.oldId}: id already agrees with category ${row.category}; nothing to fix` };
  if (marketSuffixMismatch({ id: pair.newId, category: row.category })) return { problem: `${pair.newId}: would still disagree with category ${row.category}` };
  if (reappeared) {
    if (oldRow.title !== pair.expectTitle) return { problem: `${pair.oldId}: re-added old row is titled "${oldRow.title}", batch expected "${pair.expectTitle}"` };
    return { state: 'reappeared', row };
  }
  if (newRow) {
    if (!Array.isArray(newRow.aliases) || !newRow.aliases.includes(pair.oldId)) return { problem: `${pair.newId}: row exists without ${pair.oldId} in aliases (not a resumable rename)` };
    return { state: 'resume', row };
  }
  return { state: 'pending', row };
}

/** End-state problems in a shows.json for the given pairs. */
function verifyShows(pairs, shows) {
  const out = [];
  for (const p of pairs) {
    const olds = shows.filter((s) => s && s.id === p.oldId);
    const news = shows.filter((s) => s && s.id === p.newId);
    if (olds.length) out.push(`${p.oldId}: ${olds.length} row(s) still carry the old id`);
    if (news.length !== 1) { out.push(`${p.newId}: expected exactly 1 row, found ${news.length}`); continue; }
    const slug = news[0].slug;
    const sameSlug = shows.filter((s) => s && s.slug === slug);
    if (sameSlug.length !== 1) out.push(`${p.newId}: slug ${slug} is shared by ${sameSlug.map((s) => s.id).join(', ')}`);
    if (!Array.isArray(news[0].aliases) || !news[0].aliases.includes(p.oldId)) out.push(`${p.newId}: aliases lost ${p.oldId} (the old URL would 404)`);
  }
  return out;
}

function parseArgs(argv) {
  const f = { batch: null, coreData: null, reviewTexts: null, web: null, apply: false, check: false };
  for (const a of argv) {
    if (a === '--apply') f.apply = true;
    else if (a === '--check') f.check = true;
    else if (a.startsWith('--batch=')) f.batch = a.slice(8);
    else if (a.startsWith('--core-data=')) f.coreData = a.slice(12);
    else if (a.startsWith('--review-texts=')) f.reviewTexts = a.slice(15);
    else if (a.startsWith('--web=')) f.web = a.slice(6);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!f.batch) throw new Error('--batch=<file> is required');
  if (f.apply && f.check) throw new Error('--apply and --check are exclusive');
  if (!f.coreData || !f.reviewTexts) throw new Error('--core-data and --review-texts are required (the real trees, never the web mirrors)');
  return f;
}

function readShows(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(doc) ? doc : doc.shows;
}

/** Remove a re-added old-id row (its renamed twin already carries the alias). */
function dropReappearedRow(showsPath, oldId) {
  const doc = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const list = Array.isArray(doc) ? doc : doc.shows;
  const kept = list.filter((s) => !(s && s.id === oldId));
  if (kept.length !== list.length - 1) throw new Error(`${oldId}: expected one re-added row, found ${list.length - kept.length}`);
  if (Array.isArray(doc)) doc.splice(0, doc.length, ...kept); else doc.shows = kept;
  const { createShowsWriteGuard } = require('./lib/shows-write-guard');
  createShowsWriteGuard(showsPath).saveShows(doc, { allowShrink: true, reason: 'rename-show-ids-batch: drop re-added old row' });
  console.warn(`  warning: dropped re-added ${oldId} row (a concurrent edit to it is lost)`);
}

const USAGE = `Usage: node scripts/rename-show-ids-batch.js --batch=<file> --core-data=<dir> --review-texts=<dir> [--web=<dir>] [--apply | --check]

Dry run by default. --apply renames every pair in the batch; --check verifies
that every pair is fully renamed in all three trees. Exit 0 ok, 2 refused, 1 failed.
`;

function main() {
  const { hasHelpFlag } = require('./lib/cli-help.js');
  if (hasHelpFlag(process.argv.slice(2))) { process.stdout.write(USAGE); return; }
  let f;
  try { f = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
  const batch = JSON.parse(fs.readFileSync(f.batch, 'utf8'));
  const problems = batchProblems(batch);
  if (problems.length) { console.error(`refused: ${problems.join('; ')}`); process.exit(2); }
  const pairs = batch.renames;
  const states = new Map();

  const { planShowIdRename, applyShowIdRename, buildSqlMigration } = require('./lib/show-id-rename.js');
  const trees = {
    web: f.web ? path.resolve(f.web) : path.resolve(__dirname, '..'),
    coreData: path.resolve(f.coreData),
    reviewTexts: path.resolve(f.reviewTexts),
    scanCode: false,
    scanResidual: false,
  };
  const showsPath = path.join(trees.coreData, 'shows.json');

  // Every pair fully renamed in all three trees.
  // A lateAppend file (an append-only run log) can regain old ids from a job
  // that started before the rename, so it only warns; a later --apply sweeps it.
  const { SHOW_ID_KEYED_FILES } = require('./lib/show-id-keyed-files.js');
  const isLate = (c) => (c.entryIndexes || []).length > 0 && c.entryIndexes.every((i) => SHOW_ID_KEYED_FILES[i] && SHOW_ID_KEYED_FILES[i].lateAppend);
  const leftOver = (warnings = []) => {
    const left = [];
    for (const p of pairs) {
      const plan = planShowIdRename(p.oldId, p.newId, trees);
      const lateChanges = plan.changes.filter(isLate);
      const changes = plan.changes.filter((c) => !isLate(c));
      if (lateChanges.length) warnings.push(`${p.oldId}: old id re-appended to ${lateChanges.map((c) => c.path).join(', ')}`);
      if (changes.length || plan.moves.length) left.push(`${p.oldId}: ${changes.length} file(s), ${plan.moves.length} move(s) still pending`);
    }
    return [...left, ...verifyShows(pairs, readShows(showsPath))];
  };
  if (f.check) {
    const warnings = [];
    const left = leftOver(warnings);
    for (const w of warnings) console.log(`::warning::${w} (a late run-log append; the next --apply of any batch holding this pair sweeps it)`);
    if (left.length) { console.error(`::error::rename incomplete:\n  ${left.join('\n  ')}`); process.exit(1); }
    console.log(`checked: ${pairs.length} rename(s) complete in all three trees`);
    return;
  }

  // Phase A: every pair must be pending or resumable and plan cleanly.
  const shows = readShows(showsPath);
  const refused = [];
  for (const p of pairs) {
    const st = pairState(p, shows);
    if (st.problem) { refused.push(st.problem); continue; }
    states.set(p.oldId, st.state);
    // The engine refuses while both rows exist; the old one goes in Phase B.
    if (st.state === 'reappeared') { console.log(`reappeared ${p.oldId} -> ${p.newId}: old row re-added by a merge; --apply drops it and resumes`); continue; }
    const plan = planShowIdRename(p.oldId, p.newId, trees);
    if (!plan.ok) refused.push(...plan.refusals.map((r) => `${p.oldId}: ${r}`));
    console.log(`${st.state.padEnd(7)} ${p.oldId} -> ${p.newId}  slug ${plan.oldSlug}${plan.slugChanged ? ` -> ${plan.newSlug}` : ' (kept)'}  ${plan.summary ? `${plan.summary.filesRewritten} files, ${plan.summary.dirsMoved + plan.summary.filesMoved} moves${plan.summary.orphansDropped ? `, ${plan.summary.orphansDropped} orphan target entries dropped` : ''}` : ''}`);
  }
  if (refused.length) { console.error(`\nrefused (${refused.length}), nothing written:\n  ${refused.join('\n  ')}`); process.exit(2); }
  if (!f.apply) { console.log(`\ndry run: ${pairs.length} pair(s) plan cleanly; pass --apply to execute`); return; }

  // Phase B: apply one by one.
  for (const p of pairs) {
    if (states.get(p.oldId) === 'reappeared') dropReappearedRow(showsPath, p.oldId);
    const plan = planShowIdRename(p.oldId, p.newId, trees);
    if (!plan.ok) { console.error(`::error::${p.oldId}: refused at apply time: ${plan.refusals.join('; ')}`); process.exit(1); }
    const r = applyShowIdRename(plan, { log: (line) => console.log(`  ${line}`) });
    for (const w of r.warnings) console.warn(`  warning: ${w}`);
    console.log(`applied ${p.oldId} -> ${p.newId}: ${r.rewritten.length} files, ${r.moved.length} moves`);
  }

  // Phase C: nothing left to change, end state right.
  const left = leftOver();
  if (left.length) { console.error(`::error::rename incomplete:\n  ${left.join('\n  ')}`); process.exit(1); }

  console.log('\n--- Supabase migration (run after the deploy is live) ---');
  for (const p of pairs) process.stdout.write(buildSqlMigration(p.oldId, p.newId).statements.join('\n') + '\n');
  console.log(`\nrenamed ${pairs.length} show id(s)`);
}

if (require.main === module) main();

module.exports = { batchProblems, pairState, verifyShows, MAX_PAIRS };
