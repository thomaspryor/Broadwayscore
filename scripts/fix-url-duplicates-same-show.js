#!/usr/bin/env node
/**
 * Fix URL duplicates within the same show
 *
 * Finds review files with the same URL in the same show directory
 * and merges them into a single canonical file.
 *
 * Canonical file selection priority:
 *   1. File with most complete data (fullText, llmScore)
 *   2. File with known critic name (vs "unknown")
 *   3. File with canonical outlet (nytimes vs newyorkmagazine for nymag.com)
 *
 * Usage:
 *   node scripts/fix-url-duplicates-same-show.js --dry-run
 *   node scripts/fix-url-duplicates-same-show.js
 */

const fs = require('fs');
const path = require('path');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

// Domain to canonical outlet mapping (for resolving outlet conflicts)
const DOMAIN_CANONICAL_OUTLET = {
  'nymag.com': 'vulture',
  'newyorktheater.me': 'newyorktheater',
  'nytimes.com': 'nytimes',
  'wsj.com': 'wsj',
  'amny.com': 'amny',
  'chicagotribune.com': 'chicagotribune',
  'variety.com': 'variety',
  'vulture.com': 'vulture',
  'hollywoodreporter.com': 'hollywood-reporter',
  'timeout.com': 'timeout',
  'theaterly.com': 'theatrely',
  'broadwaynews.com': 'broadwaynews',
  'theatermania.com': 'theatermania'
};

// Critic name canonicalization
const CRITIC_CANONICAL = {
  'elisabeth-vincentelli': 'elisabeth-vincentelli',
  'elizabeth-vincentelli': 'elisabeth-vincentelli',  // typo
  'matt-windman': 'matt-windman',
  'matt': 'matt-windman',
  'chris-jones': 'chris-jones',
  'chris': 'chris-jones',
  'jonathan-mandell': 'jonathan-mandell',
  'unknown': 'unknown'
};

function normalizeUrl(url) {
  if (!url) return null;
  return url.split('?')[0].toLowerCase().replace(/\/$/, '');
}

function getDomainFromUrl(url) {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    return hostname;
  } catch {
    return null;
  }
}

function scoreFile(data, domain) {
  let score = 0;

  // CRITICAL: Has known critic (not "unknown") - highest priority!
  if (data.criticName && data.criticName !== 'unknown' && !data.criticName.includes('unknown')) {
    score += 200;  // Big bonus for known critic
  }

  // CRITICAL: Has proper outlet (not "unknown" or "advertisement")
  if (data.outletId && data.outletId !== 'unknown' && !data.outletId.includes('advertisement')) {
    score += 150;  // Big bonus for proper outlet
  }

  // Has fullText
  if (data.fullText && data.fullText.length > 500) score += 50;
  else if (data.fullText && data.fullText.length > 200) score += 25;

  // Has llmScore
  if (data.llmScore) score += 20;

  // Has assignedScore
  if (data.assignedScore != null) score += 10;

  // Has canonical outlet for domain
  const canonicalOutlet = DOMAIN_CANONICAL_OUTLET[domain];
  if (canonicalOutlet && data.outletId === canonicalOutlet) {
    score += 30;
  }

  // Has excerpts
  if (data.dtliExcerpt) score += 5;
  if (data.bwwExcerpt) score += 5;
  if (data.showScoreExcerpt) score += 5;

  return score;
}

function mergeFiles(canonical, others) {
  const merged = { ...canonical };

  for (const other of others) {
    // Take fullText from whichever is longer
    if (other.fullText) {
      if (!merged.fullText || other.fullText.length > merged.fullText.length) {
        merged.fullText = other.fullText;
        merged.isFullReview = other.isFullReview;
        merged.textWordCount = other.textWordCount;
        if (other.textFetchedAt) merged.textFetchedAt = other.textFetchedAt;
        if (other.fetchMethod) merged.fetchMethod = other.fetchMethod;
      }
    }

    // Take llmScore if canonical doesn't have one
    if (!merged.llmScore && other.llmScore) {
      merged.llmScore = other.llmScore;
      merged.llmMetadata = other.llmMetadata;
      merged.ensembleData = other.ensembleData;
    }

    // Take assignedScore if canonical doesn't have one
    if (merged.assignedScore == null && other.assignedScore != null) {
      merged.assignedScore = other.assignedScore;
    }

    // Merge excerpts (prefer having them)
    if (!merged.dtliExcerpt && other.dtliExcerpt) merged.dtliExcerpt = other.dtliExcerpt;
    if (!merged.bwwExcerpt && other.bwwExcerpt) merged.bwwExcerpt = other.bwwExcerpt;
    if (!merged.showScoreExcerpt && other.showScoreExcerpt) merged.showScoreExcerpt = other.showScoreExcerpt;

    // Merge thumbs
    if (!merged.dtliThumb && other.dtliThumb) merged.dtliThumb = other.dtliThumb;
    if (!merged.bwwThumb && other.bwwThumb) merged.bwwThumb = other.bwwThumb;

    // Track merge
    merged.mergedFrom = merged.mergedFrom || [];
    merged.mergedFrom.push({
      filename: other._sourceFilename,
      outlet: other.outlet,
      critic: other.criticName,
      mergedAt: new Date().toISOString()
    });
  }

  return merged;
}

function getCanonicalCritic(critic) {
  return CRITIC_CANONICAL[critic] || critic;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(dryRun ? '=== DRY RUN ===' : '=== APPLYING FIXES ===');
  console.log('');

  const stats = {
    showsChecked: 0,
    urlDuplicateGroups: 0,
    filesMerged: 0,
    filesDeleted: 0,
    errors: []
  };

  const shows = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => fs.statSync(path.join(REVIEW_TEXTS_DIR, f)).isDirectory());

  for (const show of shows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, show);
    stats.showsChecked++;

    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    // Group by normalized URL
    const byUrl = {};
    for (const file of files) {
      try {
        const filePath = path.join(showDir, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const normalizedUrl = normalizeUrl(data.url);

        if (normalizedUrl) {
          if (!byUrl[normalizedUrl]) byUrl[normalizedUrl] = [];
          data._sourceFilename = file;
          data._filePath = filePath;
          byUrl[normalizedUrl].push(data);
        }
      } catch (err) {
        // Skip invalid files
      }
    }

    // Process duplicate groups
    for (const [url, filesData] of Object.entries(byUrl)) {
      if (filesData.length <= 1) continue;

      stats.urlDuplicateGroups++;
      const domain = getDomainFromUrl(filesData[0].url);

      // Score each file
      const scored = filesData.map(data => ({
        data,
        score: scoreFile(data, domain)
      })).sort((a, b) => b.score - a.score);

      const canonical = scored[0].data;
      const others = scored.slice(1).map(s => s.data);

      console.log(`${show}:`);
      console.log(`  URL: ${url.substring(0, 70)}...`);
      console.log(`  Canonical: ${canonical._sourceFilename} (score: ${scored[0].score})`);
      others.forEach((o, i) => {
        console.log(`  ${dryRun ? 'Would delete' : 'Deleting'}: ${o._sourceFilename} (score: ${scored[i + 1].score})`);
      });

      if (!dryRun) {
        try {
          // Merge all data into canonical
          const merged = mergeFiles(canonical, others);
          delete merged._sourceFilename;
          delete merged._filePath;

          // Write canonical file
          fs.writeFileSync(canonical._filePath, JSON.stringify(merged, null, 2));

          // Delete other files
          for (const other of others) {
            fs.unlinkSync(other._filePath);
            stats.filesDeleted++;
          }

          stats.filesMerged++;
        } catch (err) {
          console.log(`  ERROR: ${err.message}`);
          stats.errors.push({ show, url, error: err.message });
        }
      } else {
        stats.filesMerged++;
        stats.filesDeleted += others.length;
      }

      console.log('');
    }
  }

  console.log('=== SUMMARY ===');
  console.log(`Shows checked: ${stats.showsChecked}`);
  console.log(`URL duplicate groups found: ${stats.urlDuplicateGroups}`);
  console.log(`Files merged: ${stats.filesMerged}`);
  console.log(`Files deleted: ${stats.filesDeleted}`);
  console.log(`Errors: ${stats.errors.length}`);

  if (stats.errors.length > 0) {
    console.log('\nErrors:');
    stats.errors.forEach(e => console.log(`  - ${e.show}: ${e.error}`));
  }
}

main();
