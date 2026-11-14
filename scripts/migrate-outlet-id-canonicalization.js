#!/usr/bin/env node
/*
 * migrate-outlet-id-canonicalization.js (Sprint 4 prerequisite)
 *
 * One-shot migration: rename llm-scores + review-texts files whose on-disk
 * outletId is no longer canonical per outlet-registry.json (via
 * normalizeOutlet). Without this, Sprint 4's gather-reviews swap to
 * outlet-registry will read with the canonical outletId and silently drop
 * the 14 affected reviews from reviews.json.
 *
 * Input: data/audit/outlet-id-canonicalization-probe.json (from S1-T6).
 * Output: console summary + optional `data/audit/outlet-id-migration-
 * collisions.md` for any cases needing manual resolution.
 *
 * Flags:
 *   --dry-run        list intended renames, do nothing
 *   --no-review-text  skip review-text rename (test mode)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROBE_PATH = path.join(ROOT, 'data', 'audit', 'outlet-id-canonicalization-probe.json');
const LLM_SCORES_DIR = path.join(ROOT, 'data', 'llm-scores');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const COLLISIONS_PATH = path.join(ROOT, 'data', 'audit', 'outlet-id-migration-collisions.md');

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_REVIEW_TEXT = process.argv.includes('--no-review-text');
// Ship-check P1-4 fix: without an explicit rebuild, data/reviews.json still
// references the legacy outletId until the daily 4 AM UTC cron fires.
// --rebuild shells out to the rebuild script after a successful migration
// so callers get a consistent end state. Default off — the rebuild is
// expensive (~30 min) and may already be scheduled.
const TRIGGER_REBUILD = process.argv.includes('--rebuild');

function parseFilename(file) {
  // {showId}/{outletId}--{critic}.json
  const [showId, basename] = file.split('/');
  const m = basename && basename.match(/^(.+?)--(.+?)\.json$/);
  if (!m) return null;
  return { showId, diskOutletId: m[1], criticSlug: m[2] };
}

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

function renamePair(showId, oldOutletId, newOutletId, criticSlug, dirRoot, label) {
  const oldFile = path.join(dirRoot, showId, `${oldOutletId}--${criticSlug}.json`);
  const newFile = path.join(dirRoot, showId, `${newOutletId}--${criticSlug}.json`);
  const oldExists = exists(oldFile);
  const newExists = exists(newFile);
  if (!oldExists) {
    return { label, action: 'skip-not-found', oldFile, newFile };
  }
  if (newExists) {
    return { label, action: 'skip-collision', oldFile, newFile };
  }
  if (DRY_RUN) {
    return { label, action: 'would-rename', oldFile, newFile };
  }
  fs.renameSync(oldFile, newFile);
  // Update outletId field inside the JSON if present
  try {
    const j = JSON.parse(fs.readFileSync(newFile, 'utf8'));
    if (j && typeof j === 'object' && j.outletId === oldOutletId) {
      j.outletId = newOutletId;
      fs.writeFileSync(newFile, JSON.stringify(j, null, 2));
    }
  } catch {}
  return { label, action: 'renamed', oldFile, newFile };
}

function main() {
  if (!exists(PROBE_PATH)) {
    console.error(`Missing probe file: ${PROBE_PATH}`);
    process.exit(1);
  }
  const probe = JSON.parse(fs.readFileSync(PROBE_PATH, 'utf8'));
  const samples = (probe.samples || []).filter(s => s.diskOutletId !== s.normalizedOutletId);
  console.log(`Loaded ${samples.length} mismatches from probe (${probe.mismatchCount} total in probe)`);
  if (samples.length === 0) {
    console.log('Nothing to migrate. Re-run the probe if you expected entries.');
    process.exit(0);
  }

  const results = { renamed: 0, skipColl: 0, skipMissing: 0, would: 0 };
  const collisionLog = [];

  for (const s of samples) {
    const parts = parseFilename(s.file);
    if (!parts) { console.error(`  skipping unparseable file: ${s.file}`); continue; }
    const { showId, diskOutletId, criticSlug } = parts;
    const newOutletId = s.normalizedOutletId;

    const llm = renamePair(showId, diskOutletId, newOutletId, criticSlug, LLM_SCORES_DIR, 'llm-scores');
    console.log(`  [${llm.action}] llm-scores ${diskOutletId} → ${newOutletId} for ${showId}/${criticSlug}`);
    if (llm.action === 'renamed') results.renamed++;
    if (llm.action === 'would-rename') results.would++;
    if (llm.action === 'skip-collision') {
      results.skipColl++;
      collisionLog.push(`- llm-scores collision: ${llm.oldFile} → ${llm.newFile} already exists`);
    }
    if (llm.action === 'skip-not-found') results.skipMissing++;

    if (!SKIP_REVIEW_TEXT) {
      const rt = renamePair(showId, diskOutletId, newOutletId, criticSlug, REVIEW_TEXTS_DIR, 'review-texts');
      console.log(`  [${rt.action}] review-texts ${diskOutletId} → ${newOutletId} for ${showId}/${criticSlug}`);
      if (rt.action === 'renamed') results.renamed++;
      if (rt.action === 'would-rename') results.would++;
      if (rt.action === 'skip-collision') {
        results.skipColl++;
        collisionLog.push(`- review-texts collision: ${rt.oldFile} → ${rt.newFile} already exists`);
      }
      if (rt.action === 'skip-not-found') results.skipMissing++;
    }
  }

  console.log('');
  console.log(`Summary: renamed=${results.renamed} would-rename=${results.would} skip-collision=${results.skipColl} skip-not-found=${results.skipMissing}`);

  if (collisionLog.length > 0) {
    const md = `# Outlet-id migration collisions\n\nGenerated: ${new Date().toISOString()}\n\n` + collisionLog.join('\n') + '\n';
    fs.writeFileSync(COLLISIONS_PATH, md);
    console.log(`Collisions logged to ${COLLISIONS_PATH}`);
  }

  if (TRIGGER_REBUILD && !DRY_RUN && results.renamed > 0) {
    console.log('\n--rebuild flag set, dispatching rebuild-reviews workflow...');
    const { spawnSync } = require('child_process');
    const r = spawnSync('gh', ['workflow', 'run', 'rebuild-reviews.yml', '-f', 'reason=Post outlet-id canonicalization migration'], { stdio: 'inherit' });
    if (r.status !== 0) {
      console.error('  ⚠ gh workflow dispatch failed — run manually: gh workflow run "Rebuild Reviews Data" -f reason="Post outlet-id migration"');
    } else {
      console.log('  ✓ Rebuild dispatched. Wait with: scripts/lib/wait-for-run.sh <run-id>');
    }
  } else if (results.renamed > 0 && !DRY_RUN) {
    console.log('\n⚠ Reviews.json still references the legacy outletId until the next rebuild fires.');
    console.log('  Trigger now with: gh workflow run "Rebuild Reviews Data" -f reason="Post outlet-id migration"');
    console.log('  (Or re-run this script with --rebuild.)');
  }

  process.exit(0);
}

main();
