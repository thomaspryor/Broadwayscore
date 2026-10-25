#!/usr/bin/env node
/**
 * fix-plays-international-bylines.js — repair critic misattribution on
 * Plays International review-text files (Louise Penn report, 2026-08-03).
 *
 * The outlet's WP author metadata is always "ri-admin", so gather stored
 * criticName "Unknown" (or the registry defaultCritic "Maryam Philpott" was
 * filled in). The real byline is the first line of the article body:
 *   "<Critic Name> in the West End ★★★★☆ 22 July 2026 ..."
 *
 * This script re-derives criticName from each file's stored fullText via
 * scripts/lib/byline-from-text.js, rewrites the file, and renames it to the
 * canonical plays-international--<critic-slug>.json. Files whose text
 * contradicts their current criticName are corrected; files with no text or
 * no parseable byline are left as-is and reported (use --fetch to pull the
 * og:description byline from the live page for those).
 *
 * Collisions after rename (e.g. a --maryam-philpott and a --unknown file that
 * are the same review) keep the file with richer scoring metadata; the loser
 * moves to data/review-texts/_superseded-misattributed/ (never hard-deleted —
 * review-texts is gitignored, so there is no git safety net).
 *
 * Idempotent. Dry-run by default; pass --apply to write.
 * Run from the repo root that owns the canonical data/review-texts store.
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');

if (hasHelpFlag(process.argv)) {
  console.log(`fix-plays-international-bylines.js — repair Plays International critic attributions.

Usage:
  node scripts/fix-plays-international-bylines.js           dry run (report only)
  node scripts/fix-plays-international-bylines.js --apply   write corrections
  node scripts/fix-plays-international-bylines.js --fetch   also fetch og:description for text-less files

Run from the repo root that owns the canonical data/review-texts store.`);
  process.exit(0);
}

const { extractPlaysInternationalByline } = require('./lib/byline-from-text');
const { safeWriteReview } = require('./lib/review-write-guard');
const { foldDiacritics } = require('./lib/title-match');

const APPLY = process.argv.includes('--apply');
const FETCH = process.argv.includes('--fetch');

const ROOT = process.cwd();
const REVIEW_TEXTS = path.join(ROOT, 'data', 'review-texts');
const GRAVEYARD = path.join(REVIEW_TEXTS, '_superseded-misattributed');

if (!fs.existsSync(REVIEW_TEXTS)) {
  console.error(`No data/review-texts under ${ROOT} — run from the main checkout.`);
  process.exit(1);
}

function slugify(name) {
  return foldDiacritics(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function richness(data) {
  // Prefer the file the pipeline has invested most in.
  let score = 0;
  if (data.llmScore) score += 4;
  if (data.assignedScore != null) score += 2;
  if (data.fullText) score += 1 + Math.min(1, (data.textWordCount || 0) / 1000);
  return score;
}

async function fetchOgByline(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const html = await res.text();
  const m = /<meta property="og:description" content="([^"]+)"/.exec(html);
  return m ? extractPlaysInternationalByline(m[1]) : null;
}

async function main() {
  const changes = [];
  const unresolved = [];
  const showDirs = fs
    .readdirSync(REVIEW_TEXTS)
    .filter((d) => !d.startsWith('_') && !d.startsWith('.'));
  for (const showId of showDirs.concat('_pending')) {
    const dir = path.join(REVIEW_TEXTS, showId);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!/plays-international--.*\.json$/.test(file)) continue;
      const filePath = path.join(dir, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        unresolved.push({ showId, file, reason: `unreadable JSON: ${e.message}` });
        continue;
      }
      let parsed = extractPlaysInternationalByline(data.fullText || '');
      if (!parsed && FETCH && data.url) {
        try {
          parsed = await fetchOgByline(data.url);
          if (parsed) parsed.source = 'og:description';
        } catch (e) {
          unresolved.push({ showId, file, reason: `fetch failed: ${e.message}` });
          continue;
        }
      }
      if (!parsed) {
        unresolved.push({
          showId,
          file,
          reason: data.fullText ? 'no byline match in text' : 'no stored text',
          currentCritic: data.criticName,
        });
        continue;
      }
      if (!parsed.known) {
        unresolved.push({
          showId,
          file,
          reason: `parsed unrecognized critic "${parsed.name}" — verify manually`,
          currentCritic: data.criticName,
        });
        continue;
      }
      const targetFile = `plays-international--${slugify(parsed.name)}.json`;
      const critChanged = (data.criticName || '') !== parsed.name;
      const nameChanged = file !== targetFile;
      if (!critChanged && !nameChanged) continue;
      changes.push({ showId, file, targetFile, from: data.criticName, to: parsed.name });
      if (!APPLY) continue;
      data.criticName = parsed.name;
      const targetPath = path.join(dir, targetFile);
      if (nameChanged && fs.existsSync(targetPath)) {
        // Collision: same show already has a file for this critic. Keep the richer one.
        const existing = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
        fs.mkdirSync(GRAVEYARD, { recursive: true });
        if (richness(data) > richness(existing)) {
          fs.renameSync(targetPath, path.join(GRAVEYARD, `${showId}--dupe-${targetFile}`));
          safeWriteReview(targetPath, data);
          fs.renameSync(filePath, path.join(GRAVEYARD, `${showId}--source-${file}`));
        } else {
          fs.renameSync(filePath, path.join(GRAVEYARD, `${showId}--${file}`));
        }
      } else {
        safeWriteReview(filePath, data);
        if (nameChanged) fs.renameSync(filePath, targetPath);
      }
    }
  }

  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'} — ${changes.length} corrections:`);
  for (const c of changes) {
    console.log(`  ${c.showId}: ${c.from || '(none)'} → ${c.to}  [${c.file} → ${c.targetFile}]`);
  }
  if (unresolved.length) {
    console.log(`\n${unresolved.length} unresolved (left untouched):`);
    for (const u of unresolved) {
      console.log(`  ${u.showId}/${u.file}: ${u.reason} (current: ${u.currentCritic || 'n/a'})`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
