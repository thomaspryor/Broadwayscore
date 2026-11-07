#!/usr/bin/env node
/**
 * migrate-outlet-ids.js (BRO-4947): move review-text files from a wrong or duplicate
 * outlet id to the canonical one. Rules live in scripts/lib/outlet-id-migrations.js.
 *
 *   node scripts/migrate-outlet-ids.js            # dry run (default): prints the plan and conflicts
 *   node scripts/migrate-outlet-ids.js --apply    # rename + rewrite outletId/outlet
 *   node scripts/migrate-outlet-ids.js --rule=ID  # restrict to one rule (repeatable)
 *
 * A destination that already exists (on disk, or claimed earlier in the same run) is handled by
 * what it holds. The SAME article (same url ignoring protocol/www/query/trailing slash) is a
 * duplicate: the better copy stays at the destination (see chooseKeeper), the other is deleted,
 * and sibling duplicateOf pointers at the deleted file are retargeted. A DIFFERENT url is a
 * CONFLICT (two reviews by one critic) and is left alone: the source keeps its old id and is
 * listed for a human. The run exits 0 either way; --strict exits 1 when conflicts remain.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { safeRenameReview, safeUnlinkReview } = require('./lib/review-write-guard');
const { MIGRATIONS, planOutletMigration, sameArticleUrl, chooseKeeper } = require('./lib/outlet-id-migrations');

const ARGS = process.argv.slice(2);
if (hasHelpFlag(ARGS)) {
  console.log('Usage: node scripts/migrate-outlet-ids.js [--apply] [--rule=ID ...] [--strict]');
  process.exit(0);
}
const APPLY = ARGS.includes('--apply');
const STRICT = ARGS.includes('--strict');
const ONLY = ARGS.filter((a) => a.startsWith('--rule=')).map((a) => a.slice('--rule='.length));
const rules = ONLY.length ? MIGRATIONS.filter((m) => ONLY.includes(m.id)) : MIGRATIONS;
if (ONLY.length && rules.length !== ONLY.length) {
  console.error(`Unknown rule id. Known: ${MIGRATIONS.map((m) => m.id).join(', ')}`);
  process.exit(2);
}

const ROOT = resolveReviewTextsDir();
const counts = {};
const conflicts = [];
const failures = [];
let moved = 0;
let duplicatesResolved = 0;
let pointersRetargeted = 0;
const claims = new Map(); // destination path -> { rec, at: where that copy currently lives }

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// Siblings that pointed at a file we deleted or replaced now point at the surviving name.
// Same plain rewrite review-write-guard's sibling-pointer update uses for duplicateTextOf.
function retargetDuplicateOf(dir, oldName, newName) {
  if (oldName === newName) return;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f === oldName || f === newName) continue;
    const p = path.join(dir, f);
    const d = readJson(p);
    if (d && d.duplicateOf === oldName) {
      d.duplicateOf = newName;
      fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      pointersRetargeted++;
    }
  }
}

for (const showId of listShowDirs(ROOT)) {
  const dir = path.join(ROOT, showId);
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const rec = readJson(path.join(dir, file));
    if (!rec) continue;
    const plan = planOutletMigration(rec, file, rules);
    if (!plan) continue;
    counts[plan.rule] = (counts[plan.rule] || 0) + 1;
    const src = path.join(dir, file);
    const dst = path.join(dir, plan.newFilename);
    const claimed = claims.get(dst);
    const other = claimed ? { rec: claimed.rec, at: claimed.at } : (fs.existsSync(dst) ? { rec: readJson(dst), at: dst } : null);

    if (other) {
      if (!other.rec || !sameArticleUrl(other.rec.url, rec.url)) {
        conflicts.push({ rule: plan.rule, show: showId, file, into: plan.newFilename, sameUrl: false });
        continue;
      }
      duplicatesResolved++;
      if (chooseKeeper(other.rec, plan.newData) === 'destination') {
        // the copy at the destination stays; this one is the duplicate
        if (APPLY) {
          const r = safeUnlinkReview(src);
          if (!r.wrote) { failures.push({ show: showId, file, skipped: r.skipped || r.error || 'unlink failed' }); continue; }
          retargetDuplicateOf(dir, file, plan.newFilename);
        }
      } else {
        // this copy is better: drop the one at the destination, then move this one in
        if (APPLY) {
          const gone = safeUnlinkReview(other.at);
          if (!gone.wrote) { failures.push({ show: showId, file, skipped: `could not remove duplicate ${path.basename(other.at)}: ${gone.skipped || gone.error}` }); continue; }
          retargetDuplicateOf(dir, path.basename(other.at), plan.newFilename);
          const r = safeRenameReview(src, dst, { newData: plan.newData });
          if (r.wrote && r.renamed) { moved++; retargetDuplicateOf(dir, file, plan.newFilename); }
          else failures.push({ show: showId, file, skipped: r.skipped || r.error || 'unknown' });
        }
        claims.set(dst, { rec: plan.newData, at: APPLY ? dst : src });
      }
      continue;
    }

    claims.set(dst, { rec: plan.newData, at: APPLY ? dst : src });
    if (!APPLY) continue;
    const r = safeRenameReview(src, dst, { newData: plan.newData });
    if (r.wrote && r.renamed) { moved++; retargetDuplicateOf(dir, file, plan.newFilename); }
    else failures.push({ show: showId, file, skipped: r.skipped || r.error || 'unknown' });
  }
}

console.log(`\n=== Outlet id migration ${APPLY ? '(APPLY)' : '(DRY RUN)'} ===`);
for (const m of rules) console.log(`  ${String(counts[m.id] || 0).padStart(4)}  ${m.id}`);
console.log(`  matched ${Object.values(counts).reduce((a, b) => a + b, 0)}, same-article duplicates ${duplicatesResolved}, conflicts ${conflicts.length}${APPLY ? `, moved ${moved}, pointers retargeted ${pointersRetargeted}, failed ${failures.length}` : ''}`);
for (const c of conflicts) console.log(`  CONFLICT ${c.show}/${c.file} -> ${c.into} (different url)`);
for (const f of failures) console.log(`  FAILED   ${f.show}/${f.file}: ${f.skipped}`);
if (failures.length || (STRICT && conflicts.length)) process.exit(1);
