#!/usr/bin/env node
/**
 * Merge non-canonical review-text directories into their canonical ID directories.
 *
 * 91 shows have both a slug directory (e.g., "hadestown/") and an ID directory
 * (e.g., "hadestown-2019/"). Plus 8 orphan directories with non-standard names.
 * This script merges slug/orphan directories into the canonical ID directory,
 * using quality-based merge logic when files overlap.
 *
 * Usage:
 *   node scripts/merge-slug-directories.js --dry-run   # preview
 *   node scripts/merge-slug-directories.js             # execute
 *   node scripts/merge-slug-directories.js --limit 5   # first 5 dirs
 */
const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');

const BASE = path.join(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(BASE, 'data', 'review-texts');
const LLM_SCORES_DIR = path.join(BASE, 'data', 'llm-scores');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;

const ORPHAN_MAP = {
  'doubt-a-parable': 'doubt-2024',
  'harry-potter-and-the-cursed-child': 'harry-potter-2021',
  'harry-potter-and-the-cursed-child-parts-one-and-two': 'harry-potter-2021',
  'moulin-rouge-the-musical-review': 'moulin-rouge-2019',
  'purpose': 'purpose-2025',
  'romeo-juliet': 'romeo-juliet-2024',
  'take-me-out': 'take-me-out-2003',
  'tammy-faye': 'tammy-faye-2024',
};

const CONTENT_TIER_RANK = { complete: 5, truncated: 4, excerpt: 3, 'needs-rescrape': 2, stub: 2, invalid: 1 };

function scoreFile(data) {
  let s = 0;
  if (data.fullText && data.fullText.length > 100) s += 1000 + Math.min(data.fullText.length, 50000);
  s += (CONTENT_TIER_RANK[data.contentTier] || 0) * 100;
  if (data.ensembleData) s += 500;
  if (data.assignedScore != null) s += 200;
  if (data.url) s += 100;
  if (data.llmScore) s += 50;
  if (data.llmMetadata && data.llmMetadata.scoredAt) {
    try { s += new Date(data.llmMetadata.scoredAt).getTime() / 1e12; } catch {}
  }
  for (const key of ['dtliExcerpt', 'bwwExcerpt', 'showScoreExcerpt', 'playbillExcerpt']) {
    if (data[key]) s += 30;
  }
  return s;
}

const MERGE_SINGLE_FIELDS = [
  'url', 'publishDate', 'fullText', 'originalScore',
  'assignedScore', 'contentTier', 'isFullReview',
  'llmScore', 'llmMetadata', 'ensembleData',
  'contentVerification', 'textQuality', 'textStatus', 'archivePath',
];
const { EXCERPT_FIELDS: _CANONICAL_EXCERPTS } = require('./lib/excerpt-fields');
const EXCERPT_AND_AGG_FIELDS = [
  ..._CANONICAL_EXCERPTS,
  'playbillExcerpt',  // legacy field
  'dtliThumb', 'bwwThumb', 'dtliUrl', 'bwwRoundupUrl',
];

function mergeInto(winner, donor) {
  for (const field of MERGE_SINGLE_FIELDS) {
    if (winner[field] == null && donor[field] != null) winner[field] = donor[field];
  }
  for (const field of EXCERPT_AND_AGG_FIELDS) {
    if (!winner[field] && donor[field]) winner[field] = donor[field];
  }
  if (donor.sources && Array.isArray(donor.sources)) {
    if (!winner.sources) winner.sources = [];
    const existing = new Set(winner.sources);
    for (const src of donor.sources) if (!existing.has(src)) winner.sources.push(src);
  }
  if (donor.source && !winner.source) winner.source = donor.source;
  if (donor.llmMetadata?.scoredAt && winner.llmMetadata?.scoredAt) {
    if (new Date(donor.llmMetadata.scoredAt) > new Date(winner.llmMetadata.scoredAt)) {
      winner.llmScore = donor.llmScore;
      winner.llmMetadata = donor.llmMetadata;
      winner.ensembleData = donor.ensembleData || winner.ensembleData;
    }
  }
  if (!winner.ensembleData && donor.ensembleData) {
    winner.ensembleData = donor.ensembleData;
    if (donor.llmScore) winner.llmScore = donor.llmScore;
    if (donor.llmMetadata) winner.llmMetadata = donor.llmMetadata;
  }
  if ((CONTENT_TIER_RANK[donor.contentTier] || 0) > (CONTENT_TIER_RANK[winner.contentTier] || 0)) {
    winner.contentTier = donor.contentTier;
  }
  if (donor.fullText && (!winner.fullText || (
    donor.fullText.length > winner.fullText.length &&
    (CONTENT_TIER_RANK[donor.contentTier] || 0) >= (CONTENT_TIER_RANK[winner.contentTier] || 0)
  ))) {
    winner.fullText = donor.fullText;
    if (donor.isFullReview) winner.isFullReview = true;
  }
}

function normalizeUrl(url) {
  if (!url) return null;
  return url.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();
}

function buildDirectoryMap() {
  const shows = JSON.parse(fs.readFileSync(path.join(BASE, 'data', 'shows.json'), 'utf8')).shows;
  const slugToId = new Map();
  for (const s of shows) {
    if (s.id !== s.slug) slugToId.set(s.slug, s.id);
  }
  const idSet = new Set(shows.map(s => s.id));
  const rtDirs = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name);
  const mapping = new Map();
  for (const dir of rtDirs) {
    if (idSet.has(dir)) continue;
    if (slugToId.has(dir)) { mapping.set(dir, slugToId.get(dir)); continue; }
    if (ORPHAN_MAP[dir]) { mapping.set(dir, ORPHAN_MAP[dir]); continue; }
  }
  return mapping;
}

function main() {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) { console.error('No review-texts directory'); process.exit(1); }
  const mapping = buildDirectoryMap();
  console.log(`Found ${mapping.size} non-canonical directories to merge\n`);

  const stats = { dirsProcessed: 0, filesDeleted: 0, filesMerged: 0, filesMoved: 0, filesConflict: 0, dirsRemoved: 0, llmOps: 0 };
  const conflicts = [];

  let processed = 0;
  for (const [sourceDir, canonicalId] of mapping) {
    if (processed >= LIMIT) break;
    processed++;
    stats.dirsProcessed++;
    const sourcePath = path.join(REVIEW_TEXTS_DIR, sourceDir);
    const canonicalPath = path.join(REVIEW_TEXTS_DIR, canonicalId);
    if (!fs.existsSync(canonicalPath)) { if (!DRY_RUN) fs.mkdirSync(canonicalPath, { recursive: true }); }
    const sourceFiles = fs.readdirSync(sourcePath).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    const beforeCount = fs.existsSync(canonicalPath) ? fs.readdirSync(canonicalPath).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json').length : 0;

    for (const file of sourceFiles) {
      const sourceFilePath = path.join(sourcePath, file);
      const canonicalFilePath = path.join(canonicalPath, file);
      let sourceData;
      try { sourceData = JSON.parse(fs.readFileSync(sourceFilePath, 'utf8')); } catch (e) { continue; }

      if (fs.existsSync(canonicalFilePath)) {
        let canonicalData;
        try { canonicalData = JSON.parse(fs.readFileSync(canonicalFilePath, 'utf8')); } catch { continue; }
        const sourceFlagged = sourceData.wrongShow || sourceData.wrongProduction;
        const canonFlagged = canonicalData.wrongShow || canonicalData.wrongProduction;
        if (sourceFlagged && !canonFlagged) {
          // Source is bad, canonical is good — delete source
          if (!DRY_RUN) fs.unlinkSync(sourceFilePath);
          stats.filesDeleted++;
          continue;
        }
        if (canonFlagged && !sourceFlagged) {
          // Canonical is bad, source is good — replace canonical with source
          if (!DRY_RUN) {
            sourceData.showId = canonicalId;
            safeWriteReview(canonicalFilePath, sourceData);
            fs.unlinkSync(sourceFilePath);
          }
          stats.filesMerged++;
          continue;
        }
        if (sourceFlagged && canonFlagged) {
          // Both flagged — delete source, keep canonical as-is
          if (!DRY_RUN) fs.unlinkSync(sourceFilePath);
          stats.filesDeleted++;
          continue;
        }
        const sUrl = normalizeUrl(sourceData.url), cUrl = normalizeUrl(canonicalData.url);
        if (sUrl && cUrl && sUrl !== cUrl) {
          conflicts.push({ dir: sourceDir, canonicalId, file, sourceUrl: sourceData.url, canonicalUrl: canonicalData.url });
          stats.filesConflict++;
          continue;
        }
        if (!DRY_RUN) {
          if (scoreFile(sourceData) > scoreFile(canonicalData)) {
            mergeInto(sourceData, canonicalData);
            sourceData.showId = canonicalId;
            safeWriteReview(canonicalFilePath, sourceData);
          } else {
            mergeInto(canonicalData, sourceData);
            canonicalData.showId = canonicalId;
            safeWriteReview(canonicalFilePath, canonicalData);
          }
          fs.unlinkSync(sourceFilePath);
        }
        stats.filesMerged++;
        const sLlm = path.join(LLM_SCORES_DIR, sourceDir, file);
        if (fs.existsSync(sLlm)) { if (!DRY_RUN) { try { fs.unlinkSync(sLlm); } catch {} } stats.llmOps++; }
      } else {
        if (!DRY_RUN) {
          sourceData.showId = canonicalId;
          safeWriteReview(canonicalFilePath, sourceData);
          fs.unlinkSync(sourceFilePath);
        }
        stats.filesMoved++;
        const sLlm = path.join(LLM_SCORES_DIR, sourceDir, file);
        const cLlm = path.join(LLM_SCORES_DIR, canonicalId, file);
        if (fs.existsSync(sLlm)) {
          if (!DRY_RUN) {
            const cLlmDir = path.join(LLM_SCORES_DIR, canonicalId);
            if (!fs.existsSync(cLlmDir)) fs.mkdirSync(cLlmDir, { recursive: true });
            try { fs.renameSync(sLlm, cLlm); } catch { fs.copyFileSync(sLlm, cLlm); fs.unlinkSync(sLlm); }
          }
          stats.llmOps++;
        }
      }
    }

    if (!DRY_RUN) {
      const remaining = fs.readdirSync(sourcePath);
      if (remaining.length === 0) { fs.rmdirSync(sourcePath); stats.dirsRemoved++; }
      else console.warn(`WARNING: ${sourceDir} still has ${remaining.length} files`);
      const sLlmDir = path.join(LLM_SCORES_DIR, sourceDir);
      if (fs.existsSync(sLlmDir) && fs.readdirSync(sLlmDir).length === 0) fs.rmdirSync(sLlmDir);
    }

    const afterCount = !DRY_RUN && fs.existsSync(canonicalPath) ? fs.readdirSync(canonicalPath).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json').length : beforeCount;
    console.log(`  ${sourceDir} → ${canonicalId}: ${beforeCount} → ${afterCount} files`);
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Dirs processed: ${stats.dirsProcessed}, removed: ${stats.dirsRemoved}`);
  console.log(`Files: ${stats.filesDeleted} deleted, ${stats.filesMerged} merged, ${stats.filesMoved} moved, ${stats.filesConflict} conflicts`);
  if (DRY_RUN) console.log('(DRY RUN)');
  if (conflicts.length > 0) {
    console.log(`\n=== URL CONFLICTS (${conflicts.length}) ===`);
    for (const c of conflicts) console.log(`  ${c.dir}/${c.file}: ${c.sourceUrl} vs ${c.canonicalUrl}`);
  }
}

main();
