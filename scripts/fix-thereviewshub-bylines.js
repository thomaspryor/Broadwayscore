#!/usr/bin/env node
/**
 * fix-thereviewshub-bylines.js — recover real critic bylines for The Reviews
 * Hub review-text files credited to the house byline ("The Reviews Hub -
 * London" etc.) or Unknown.
 *
 * The outlet's WP author metadata is the house account, but every review page
 * prints the real critic in the body as "Reviewer: <Name>". Our stored
 * fullText strips that line, so this script re-fetches each live page and
 * extracts it. Same misattribution class as Plays International
 * (Louise Penn report, 2026-08-03) — see fix-plays-international-bylines.js.
 *
 * Idempotent. Dry-run by default; pass --apply to write. Fetches are
 * sequential with a 1s delay. Files whose page can't be fetched or has no
 * Reviewer line are left untouched and reported.
 *
 * Run from the repo root that owns the canonical data/review-texts store.
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');

if (hasHelpFlag(process.argv)) {
  console.log(`fix-thereviewshub-bylines.js — recover The Reviews Hub critic bylines from live pages.

Usage:
  node scripts/fix-thereviewshub-bylines.js           dry run (fetches pages, reports only)
  node scripts/fix-thereviewshub-bylines.js --apply   write corrections

Run from the repo root that owns the canonical data/review-texts store.`);
  process.exit(0);
}

const { safeWriteReview } = require('./lib/review-write-guard');
const { foldDiacritics } = require('./lib/title-match');

const APPLY = process.argv.includes('--apply');
const ROOT = process.cwd();
const REVIEW_TEXTS = path.join(ROOT, 'data', 'review-texts');
const GRAVEYARD = path.join(REVIEW_TEXTS, '_superseded-misattributed');

const HOUSE_RE = /^(the reviews hub.*|unknown|unnamed|)$/i;
// Unicode-aware: critic names include accented letters (e.g. Nilgün Yusuf).
const REVIEWER_RE =
  /Reviewer:\s*(?:<[^>]*>\s*)*(\p{Lu}[\p{L}'’.-]*(?:\s+\p{Lu}[\p{L}'’.-]*){0,3})/u;

if (!fs.existsSync(REVIEW_TEXTS)) {
  console.error(`No data/review-texts under ${ROOT} — run from the main checkout.`);
  process.exit(1);
}

function slugify(name) {
  return foldDiacritics(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function richness(data) {
  let score = 0;
  if (data.llmScore) score += 4;
  if (data.assignedScore != null) score += 2;
  if (data.fullText) score += 1 + Math.min(1, (data.textWordCount || 0) / 1000);
  return score;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      if (!/^thereviewshub--.*\.json$/.test(file)) continue;
      const filePath = path.join(dir, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        unresolved.push({ showId, file, reason: `unreadable JSON: ${e.message}` });
        continue;
      }
      if (!HOUSE_RE.test((data.criticName || '').trim())) continue; // already a person
      if (!data.url || !/thereviewshub\.com\/.+/.test(data.url)) {
        unresolved.push({ showId, file, reason: `no article url (${data.url || 'none'})` });
        continue;
      }
      let name = null;
      try {
        const res = await fetch(data.url, {
          signal: AbortSignal.timeout(20000),
          headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        // Match page-wide, but only trust a unanimous result — a related-posts
        // widget could surface another article's "Reviewer:" line.
        const names = [...html.matchAll(new RegExp(REVIEWER_RE, 'gu'))].map((m) => m[1].trim());
        const unique = [...new Set(names)];
        if (unique.length === 1) name = unique[0];
        else if (unique.length > 1) {
          unresolved.push({ showId, file, reason: `conflicting Reviewer lines: ${unique.join(' / ')}` });
          await sleep(1000);
          continue;
        }
      } catch (e) {
        unresolved.push({ showId, file, reason: `fetch failed: ${e.message}` });
        await sleep(1000);
        continue;
      }
      await sleep(1000);
      if (!name) {
        unresolved.push({ showId, file, reason: 'no Reviewer line on page', currentCritic: data.criticName });
        continue;
      }
      const targetFile = `thereviewshub--${slugify(name)}.json`;
      changes.push({ showId, file, targetFile, from: data.criticName, to: name });
      if (!APPLY) continue;
      data.criticName = name;
      const targetPath = path.join(dir, targetFile);
      if (file !== targetFile && fs.existsSync(targetPath)) {
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
        if (file !== targetFile) fs.renameSync(filePath, targetPath);
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
      console.log(`  ${u.showId}/${u.file}: ${u.reason}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
