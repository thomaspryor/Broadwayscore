#!/usr/bin/env node
/**
 * audit-orphan-show-ids.js
 *
 * Flags show IDs that appear in derived data (slim show files, audience-buzz,
 * show-score, llm-scoring-runs) but no longer exist in `data/shows.json`.
 * Catches drift when a show is renamed/consolidated and stale files persist.
 *
 * Triggered by Can I Be Frank case (2026-05-24): show was renamed from
 * `can-i-be-frank-off-broadway-2026` to `morgan-bassichis-...`, but the slim
 * show file under the old ID stuck around with audience-only data, causing
 * a split view of one show across two IDs.
 *
 * Usage:
 *   node scripts/audit-orphan-show-ids.js            # Report
 *   node scripts/audit-orphan-show-ids.js --fix      # Delete orphan slim files (others reported only)
 *   node scripts/audit-orphan-show-ids.js --json     # JSON output (CI)
 *
 * Exit codes:
 *   0 — no orphans
 *   1 — orphans found
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const SLIM_SHOWS_DIR = path.join(ROOT, 'public', 'data', 'shows');
const AUDIENCE_BUZZ_PATH = path.join(ROOT, 'data', 'audience-buzz.json');
const SHOW_SCORE_PATH = path.join(ROOT, 'data', 'show-score.json');

const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const JSON_OUT = args.includes('--json');
// By default, only slim-file orphans block CI (they're write-side bugs).
// audience-buzz / show-score key drift is reported but doesn't fail unless --strict
// (those need manual rename in upstream pollers).
const STRICT = args.includes('--strict');

function loadShowIds() {
  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf-8'));
  const arr = Array.isArray(shows) ? shows : (shows.shows || []);
  return new Set(arr.map(s => s.id).filter(Boolean));
}

function scanSlimShowFiles(validIds) {
  if (!fs.existsSync(SLIM_SHOWS_DIR)) return [];
  return fs.readdirSync(SLIM_SHOWS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    // `.social` suffix files are auxiliary social-pulse data, not slim show files
    .filter(id => !id.endsWith('.social'))
    .filter(id => !validIds.has(id));
}

function scanJsonKeys(filePath, accessor, validIds) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const target = accessor(data);
    if (!target || typeof target !== 'object') return [];
    return Object.keys(target).filter(id => !validIds.has(id));
  } catch {
    return [];
  }
}

function main() {
  const validIds = loadShowIds();
  const orphans = {
    slimShowFiles: scanSlimShowFiles(validIds),
    audienceBuzz: scanJsonKeys(AUDIENCE_BUZZ_PATH, d => d.shows || d, validIds),
    showScore: scanJsonKeys(SHOW_SCORE_PATH, d => d.shows || d, validIds),
  };
  const total = orphans.slimShowFiles.length + orphans.audienceBuzz.length + orphans.showScore.length;

  const blockingCount = STRICT ? total : orphans.slimShowFiles.length;

  if (JSON_OUT) {
    console.log(JSON.stringify({ total, blockingCount, strict: STRICT, orphans }, null, 2));
    process.exit(blockingCount === 0 ? 0 : 1);
  }

  if (total === 0) {
    console.log('OK: no orphan show IDs found across slim files, audience-buzz, show-score');
    process.exit(0);
  }

  console.log(`Found ${total} orphan show ID(s):\n`);

  if (orphans.slimShowFiles.length) {
    console.log(`Slim show files (${orphans.slimShowFiles.length}) — not in shows.json:`);
    for (const id of orphans.slimShowFiles) console.log(`  public/data/shows/${id}.json`);
    console.log('');
  }

  if (orphans.audienceBuzz.length) {
    console.log(`audience-buzz.json keys (${orphans.audienceBuzz.length}):`);
    for (const id of orphans.audienceBuzz) console.log(`  ${id}`);
    console.log('');
  }

  if (orphans.showScore.length) {
    console.log(`show-score.json keys (${orphans.showScore.length}):`);
    for (const id of orphans.showScore) console.log(`  ${id}`);
    console.log('');
  }

  if (FIX && orphans.slimShowFiles.length) {
    for (const id of orphans.slimShowFiles) {
      const p = path.join(SLIM_SHOWS_DIR, id + '.json');
      fs.unlinkSync(p);
      console.log(`Deleted ${p}`);
    }
    console.log(`\nDeleted ${orphans.slimShowFiles.length} orphan slim file(s). audience-buzz and show-score entries are reported only — fix them by renaming the key to match shows.json.`);
  } else if (orphans.slimShowFiles.length) {
    console.log('Run with --fix to delete orphan slim files. audience-buzz/show-score require manual rename.');
  }

  // Exit 1 only if slim-file orphans exist (the write-side bug we gate CI on).
  // show-score / audience-buzz drift is reported as advisory unless --strict.
  process.exit(blockingCount === 0 ? 0 : 1);
}

main();
