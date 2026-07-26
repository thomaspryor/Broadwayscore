#!/usr/bin/env node
/**
 * Consolidate intra-show duplicate review-text files.
 *
 * Files with different outlet-ID variants (e.g., "guardian--X.json" vs
 * "the-guardian-uk--X.json") that normalizeOutlet() maps to the same
 * canonical outlet are merged: the "best" file is kept (or renamed to
 * the canonical filename), unique data from duplicates is merged in,
 * and duplicates are deleted. Corresponding llm-scores files are also
 * cleaned up.
 *
 * Usage:
 *   node scripts/consolidate-duplicate-reviews.js --dry-run   # preview
 *   node scripts/consolidate-duplicate-reviews.js             # execute
 *   node scripts/consolidate-duplicate-reviews.js --limit 20  # first 20 groups
 */
const fs = require('fs');
const path = require('path');
const { normalizeOutlet, normalizeCritic, generateReviewFilename } = require('./lib/review-normalization');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const LLM_SCORES_DIR = path.join(__dirname, '..', 'data', 'llm-scores');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;

// ---------------------------------------------------------------------------
// Scoring a file's "quality" for ranking which to keep
// ---------------------------------------------------------------------------

const CONTENT_TIER_RANK = { complete: 5, truncated: 4, excerpt: 3, 'needs-rescrape': 2, stub: 2, invalid: 1 };

function scoreFile(data) {
  let s = 0;
  // Full text is king
  if (data.fullText && data.fullText.length > 100) s += 1000 + Math.min(data.fullText.length, 50000);
  // Content tier
  s += (CONTENT_TIER_RANK[data.contentTier] || 0) * 100;
  // Ensemble data beats single-model
  if (data.ensembleData) s += 500;
  // Has an assigned score
  if (data.assignedScore != null) s += 200;
  // Has a URL
  if (data.url) s += 100;
  // Has LLM score at all
  if (data.llmScore) s += 50;
  // Newer scoring timestamp preferred (tiebreaker)
  if (data.llmMetadata && data.llmMetadata.scoredAt) {
    try { s += new Date(data.llmMetadata.scoredAt).getTime() / 1e12; } catch {}
  }
  // Excerpts from various sources
  for (const key of ['dtliExcerpt', 'bwwExcerpt', 'showScoreExcerpt', 'playbillExcerpt']) {
    if (data[key]) s += 30;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Merging: copy unique fields from donor into winner
// ---------------------------------------------------------------------------

// Fields that should be merged from donor if winner lacks them
const MERGE_SINGLE_FIELDS = [
  'url', 'publishDate', 'fullText', 'originalScore',
  'assignedScore', 'contentTier', 'isFullReview',
  'llmScore', 'llmMetadata', 'ensembleData',
  'contentVerification', 'textQuality', 'textStatus', 'archivePath',
];

// Source-specific excerpt fields — always keep from both sides
const { EXCERPT_FIELDS: _CANONICAL_EXCERPTS } = require('./lib/excerpt-fields');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `consolidate-duplicate-reviews.js — Consolidate intra-show duplicate review-text files.

Usage:
  node scripts/consolidate-duplicate-reviews.js [options]
  node scripts/consolidate-duplicate-reviews.js --help, -h    print this usage and exit
`;
const EXCERPT_MERGE_FIELDS = [
  ..._CANONICAL_EXCERPTS,
  'playbillExcerpt',  // legacy field
  'dtliThumb', 'bwwThumb', 'dtliUrl', 'bwwRoundupUrl',
];

// Thumb fields from aggregators
const THUMB_FIELDS = ['dtliThumb', 'bwwThumb'];

function mergeInto(winner, donor) {
  // Merge single-value fields (only if winner doesn't have them)
  for (const field of MERGE_SINGLE_FIELDS) {
    if (winner[field] == null && donor[field] != null) {
      winner[field] = donor[field];
    }
  }

  // Always merge excerpt fields (these come from different sources)
  for (const field of EXCERPT_MERGE_FIELDS) {
    if (!winner[field] && donor[field]) {
      winner[field] = donor[field];
    }
  }

  // Merge sources arrays
  if (donor.sources && Array.isArray(donor.sources)) {
    if (!winner.sources) winner.sources = [];
    const existing = new Set(winner.sources);
    for (const src of donor.sources) {
      if (!existing.has(src)) winner.sources.push(src);
    }
  }
  if (donor.source && !winner.source) {
    winner.source = donor.source;
  }

  // Keep newer llmMetadata.scoredAt
  if (donor.llmMetadata && donor.llmMetadata.scoredAt && winner.llmMetadata && winner.llmMetadata.scoredAt) {
    if (new Date(donor.llmMetadata.scoredAt) > new Date(winner.llmMetadata.scoredAt)) {
      winner.llmScore = donor.llmScore;
      winner.llmMetadata = donor.llmMetadata;
      winner.ensembleData = donor.ensembleData || winner.ensembleData;
    }
  }

  // Prefer ensemble over single-model
  if (!winner.ensembleData && donor.ensembleData) {
    winner.ensembleData = donor.ensembleData;
    // Also take the ensemble llmScore/metadata if winner lacks ensemble
    if (donor.llmScore) winner.llmScore = donor.llmScore;
    if (donor.llmMetadata) winner.llmMetadata = donor.llmMetadata;
  }

  // Prefer complete contentTier
  const winnerRank = CONTENT_TIER_RANK[winner.contentTier] || 0;
  const donorRank = CONTENT_TIER_RANK[donor.contentTier] || 0;
  if (donorRank > winnerRank) {
    winner.contentTier = donor.contentTier;
  }

  // Prefer fullText from the one that has it / is longer
  if (donor.fullText && (!winner.fullText || donor.fullText.length > winner.fullText.length)) {
    winner.fullText = donor.fullText;
    if (donor.isFullReview) winner.isFullReview = true;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error('No review-texts directory found');
    process.exit(1);
  }

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'));

  let totalGroups = 0;
  let totalFilesDeleted = 0;
  let totalFilesRenamed = 0;
  let totalFilesMerged = 0;
  let llmScoresDeleted = 0;
  let llmScoresRenamed = 0;
  const errors = [];

  for (const dir of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, dir.name);
    let files;
    try {
      files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    } catch { continue; }

    // Group by canonical outlet|critic
    const keyGroups = new Map();
    for (const file of files) {
      const match = file.match(/^(.+?)--(.+)\.json$/);
      if (!match) continue;
      const [, outletId, criticSlug] = match;
      const canonicalOutlet = normalizeOutlet(outletId);
      const key = `${canonicalOutlet}|${criticSlug}`;
      if (!keyGroups.has(key)) keyGroups.set(key, []);
      keyGroups.get(key).push(file);
    }

    for (const [key, group] of keyGroups) {
      if (group.length < 2) continue;

      totalGroups++;
      if (totalGroups > LIMIT) break;

      const [canonicalOutlet, criticSlug] = key.split('|');
      const canonicalFilename = `${canonicalOutlet}--${criticSlug}.json`;

      // Read all files in group, score them
      const scored = [];
      for (const file of group) {
        const filePath = path.join(showDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          scored.push({ file, filePath, data, quality: scoreFile(data) });
        } catch (err) {
          errors.push(`Failed to read ${filePath}: ${err.message}`);
        }
      }

      if (scored.length < 2) continue;

      // Sort by quality descending — best file first
      scored.sort((a, b) => b.quality - a.quality);
      const winner = scored[0];
      const losers = scored.slice(1);

      // Merge data from losers into winner
      for (const loser of losers) {
        mergeInto(winner.data, loser.data);
      }

      // Ensure winner has canonical outlet ID
      winner.data.outletId = canonicalOutlet;

      totalFilesMerged++;

      if (DRY_RUN) {
        console.log(`[${dir.name}] ${key}`);
        console.log(`  KEEP: ${winner.file} (quality=${winner.quality.toFixed(0)})`);
        for (const l of losers) {
          console.log(`  DELETE: ${l.file} (quality=${l.quality.toFixed(0)})`);
        }
        if (winner.file !== canonicalFilename && !group.includes(canonicalFilename)) {
          console.log(`  RENAME: ${winner.file} → ${canonicalFilename}`);
        } else if (winner.file !== canonicalFilename && group.includes(canonicalFilename)) {
          // Winner isn't the canonical name, but canonical name exists in the group
          // The canonical-named file is a loser, so we delete it and rename winner
          console.log(`  RENAME: ${winner.file} → ${canonicalFilename} (replacing deleted dupe)`);
        }
        console.log();
        continue;
      }

      // --- Execute ---

      // Write merged data to winner file
      fs.writeFileSync(winner.filePath, JSON.stringify(winner.data, null, 2) + '\n');

      // Delete losers
      for (const loser of losers) {
        try {
          fs.unlinkSync(loser.filePath);
          totalFilesDeleted++;
        } catch (err) {
          errors.push(`Failed to delete ${loser.filePath}: ${err.message}`);
        }

        // Also delete corresponding llm-scores file
        const llmPath = path.join(LLM_SCORES_DIR, dir.name, loser.file);
        if (fs.existsSync(llmPath)) {
          try {
            fs.unlinkSync(llmPath);
            llmScoresDeleted++;
          } catch (err) {
            errors.push(`Failed to delete llm-score ${llmPath}: ${err.message}`);
          }
        }
      }

      // Rename winner to canonical filename if needed
      if (winner.file !== canonicalFilename) {
        const newPath = path.join(showDir, canonicalFilename);
        // Safety: if canonical already exists (shouldn't after deletes, but be safe)
        if (!fs.existsSync(newPath)) {
          try {
            fs.renameSync(winner.filePath, newPath);
            totalFilesRenamed++;
          } catch (err) {
            errors.push(`Failed to rename ${winner.filePath} → ${newPath}: ${err.message}`);
          }

          // Also rename corresponding llm-scores file
          const oldLlm = path.join(LLM_SCORES_DIR, dir.name, winner.file);
          const newLlm = path.join(LLM_SCORES_DIR, dir.name, canonicalFilename);
          if (fs.existsSync(oldLlm) && !fs.existsSync(newLlm)) {
            try {
              fs.renameSync(oldLlm, newLlm);
              llmScoresRenamed++;
            } catch (err) {
              errors.push(`Failed to rename llm-score ${oldLlm} → ${newLlm}: ${err.message}`);
            }
          }
        }
      }
    }

    if (totalGroups > LIMIT) break;
  }

  // Summary
  console.log('=== SUMMARY ===');
  console.log(`Duplicate groups processed: ${Math.min(totalGroups, LIMIT)}`);
  if (DRY_RUN) {
    console.log('(DRY RUN — no changes made)');
  } else {
    console.log(`Files merged:    ${totalFilesMerged}`);
    console.log(`Files deleted:   ${totalFilesDeleted}`);
    console.log(`Files renamed:   ${totalFilesRenamed}`);
    console.log(`LLM scores deleted: ${llmScoresDeleted}`);
    console.log(`LLM scores renamed: ${llmScoresRenamed}`);
  }
  if (errors.length) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ${e}`);
  }
}

main();
