#!/usr/bin/env node
/**
 * Flag review files with junk URLs as wrongShow: true
 *
 * Identifies review files where the URL points to non-theater content
 * (Variety film/TV/music sections, malformed URLs, YouTube videos, etc.)
 * and flags them so rebuild excludes them and URL index ignores them.
 *
 * Usage:
 *   node scripts/flag-junk-url-reviews.js --dry-run    # Preview changes
 *   node scripts/flag-junk-url-reviews.js --limit 5    # Flag first 5 only (test)
 *   node scripts/flag-junk-url-reviews.js              # Flag all
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const dryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

// Junk URL patterns — URL paths that definitively indicate wrong content type
const JUNK_PATTERNS = [
  // Variety non-theater sections (film, TV, music, gallery, awards, etc.)
  {
    test: url => /variety\.com\/([\d]{4}\/)?(film|tv|music|gallery|lists|awards|digital|scene|vip|global)\//i.test(url),
    reason: 'URL points to Variety non-theater section (film/TV/music/gallery/etc.) — not a theater review. From RSS feed pollution.',
  },
  // Malformed/broken URLs
  {
    test: url => /^https?:\/\/(Check%20|TBA)/i.test(url),
    reason: 'Malformed URL (placeholder text, not a real review URL). From aggregator data error.',
  },
  {
    test: url => /click\.icptrack\.com/i.test(url),
    reason: 'URL is a tracking redirect, not a direct review link. From aggregator data error.',
  },
  // YouTube (video reviews, not text)
  {
    test: url => /youtube\.com\/watch|youtu\.be\//i.test(url),
    reason: 'URL points to YouTube video — not a text review. Text scoring requires article content.',
  },
];

/**
 * Check if review content actually matches the show despite a junk URL section.
 * Some Variety reviews are real theater reviews filed under /film/ or /music/.
 */
function contentMatchesShow(data, showId) {
  const showWords = showId.replace(/-\d{4}$/, '').replace(/-(?:off-broadway|west-end|off-west-end)$/, '')
    .split('-').filter(w => w.length > 3);
  if (showWords.length === 0) return false;

  // Check URL path for show title words
  const urlPath = (data.url || '').toLowerCase().replace(/https?:\/\/[^/]+/, '');
  const urlHasShow = showWords.filter(w => urlPath.includes(w)).length >= Math.ceil(showWords.length * 0.5);

  // Check fullText for show title words (if substantial text exists)
  const text = (data.fullText || '').toLowerCase();
  const textHasShow = text.length > 100 && showWords.filter(w => text.includes(w)).length >= Math.ceil(showWords.length * 0.5);

  return urlHasShow || textHasShow;
}

function findJunkFiles() {
  const results = [];
  const shows = listShowDirs(REVIEW_TEXTS_DIR);

  for (const show of shows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, show);
    if (!fs.statSync(showDir).isDirectory()) continue;

    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const filePath = path.join(showDir, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Skip already flagged
        if (data.wrongShow || data.wrongProduction) continue;

        const url = data.url || '';
        for (const pattern of JUNK_PATTERNS) {
          if (pattern.test(url)) {
            // Safety check: if content actually matches the show, skip —
            // some outlets miscategorize theater reviews under film/music sections
            if (contentMatchesShow(data, show)) break;
            results.push({ filePath, show, file, url, reason: pattern.reason, data });
            break;
          }
        }
      } catch (e) { /* skip unparseable */ }
    }
  }

  return results;
}

function flagFile(entry) {
  const { filePath, data, reason } = entry;
  data.wrongShow = true;
  data.wrongShowReason = reason;
  data.wrongShowFlaggedAt = new Date().toISOString();
  data.wrongShowFlaggedBy = 'flag-junk-url-reviews.js';
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

// Main
const junkFiles = findJunkFiles();
const toProcess = junkFiles.slice(0, limit);

console.log(`Found ${junkFiles.length} unflagged junk URL review files`);
if (limit < Infinity) console.log(`Processing first ${limit} (--limit ${limit})`);
if (dryRun) console.log('DRY RUN — no files will be modified\n');

let flagged = 0;
for (const entry of toProcess) {
  console.log(`${dryRun ? '[DRY RUN] ' : ''}${entry.show}/${entry.file}`);
  console.log(`  URL: ${entry.url}`);
  console.log(`  Reason: ${entry.reason}`);

  if (!dryRun) {
    flagFile(entry);
    flagged++;
  }
}

console.log(`\n${dryRun ? 'Would flag' : 'Flagged'}: ${dryRun ? toProcess.length : flagged} files`);
if (junkFiles.length > limit) {
  console.log(`Remaining: ${junkFiles.length - limit} files (run without --limit to flag all)`);
}
