#!/usr/bin/env node
/**
 * Cleanup stale isMultiShowReview flags.
 *
 * The multi-show detector's SKIP_TITLES list has been expanded. Many reviews
 * were flagged by the old detector using common English words ("well", "the first",
 * "parade", etc.) that are now in SKIP_TITLES. This script re-runs the detector
 * and clears flags that would no longer trigger.
 *
 * Usage: node scripts/cleanup-stale-multishow-flags.js [--dry-run] [--verbose]
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');

// Import the current SKIP_TITLES and detector logic inline
// (We can't import TS directly, so replicate the skip set here — keep in sync with multi-show-detector.ts)
const SKIP_TITLES = new Set([
  'six', 'cats', 'rent', 'hair', 'fame', 'nine', 'once', 'annie', 'grease',
  'chicago', 'oliver', 'company', 'pippin',
  'well', 'good', 'home', 'high', 'spring', 'summer', 'november',
  'broadway', 'giant', 'molly',
  'baby', 'brothers', 'doubt', 'dream', 'race', 'rain', 'rose',
  'the audience', 'the performers', 'the news', 'the price', 'the visit',
  // Mar 2026 audit additions
  'the first', 'parade', 'just in time', 'english', 'holiday', 'care',
  'dorothy', 'working', 'emily', 'wanted', 'buddy', 'stanley', 'jackie',
  'fosse', 'sugar', 'irene', 'data', 'brooklyn', 'mail', 'marilyn',
  'legend', 'bent', 'contact', 'stomp', 'stages', 'raisin', 'betty',
  'lenny', 'sylvia', 'carrie',
]);

// Load all show titles for re-detection
const showsPath = path.join(__dirname, '../data/shows.json');
const showsRaw = JSON.parse(fs.readFileSync(showsPath, 'utf-8'));
const shows = showsRaw.shows || showsRaw;
const showTitleMap = new Map();
for (const show of shows) {
  if (show.title && show.title.length > 2) {
    showTitleMap.set(show.title.toLowerCase(), show.id || show.slug);
  }
}

function countMentions(text, title) {
  if (title.length <= 3) return 0;
  if (SKIP_TITLES.has(title.toLowerCase())) return 0;
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function reDetect(text, targetShowId) {
  if (!text || text.length < 200) return { isMultiShowReview: false, otherShows: [] };

  const lowerText = text.toLowerCase();
  const targetTitle = [...showTitleMap.entries()].find(([, id]) => id === targetShowId)?.[0];
  const targetIdWords = targetShowId.replace(/-\d{4}$/, '').split('-').filter(w => w.length > 3);

  const otherShows = [];
  for (const [title, showId] of showTitleMap) {
    if (showId === targetShowId) continue;
    if (title === targetTitle) continue;
    const titleWords = title.split(/\s+/).filter(w => w.length > 3);
    const overlap = titleWords.filter(w => targetIdWords.includes(w)).length;
    if (overlap > 0 && overlap >= titleWords.length * 0.5) continue;
    const mentions = countMentions(lowerText, title);
    if (mentions >= 3) otherShows.push({ title, mentions });
  }

  otherShows.sort((a, b) => b.mentions - a.mentions);

  if (otherShows.length >= 2) return { isMultiShowReview: true, otherShows, recommendation: 'skip' };
  if (otherShows.length === 1 && otherShows[0].mentions >= 5) return { isMultiShowReview: true, otherShows, recommendation: 'warn' };
  return { isMultiShowReview: false, otherShows };
}

// Walk review-texts directory
const reviewTextsDir = path.join(__dirname, '../data/review-texts');
let total = 0;
let cleared = 0;
let stillFlagged = 0;
let errors = 0;

function walkDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath);
    } else if (entry.name.endsWith('.json')) {
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        if (!data.isMultiShowReview) continue;
        total++;

        const text = data.fullText || '';
        const result = reDetect(text, data.showId);

        if (!result.isMultiShowReview) {
          cleared++;
          if (verbose) {
            console.log(`CLEAR: ${fullPath.replace(reviewTextsDir + '/', '')} (was: ${data.multiShowReason || 'unknown'})`);
          }
          if (!dryRun) {
            delete data.isMultiShowReview;
            delete data.multiShowReason;
            fs.writeFileSync(fullPath, JSON.stringify(data, null, 2) + '\n');
          }
        } else {
          stillFlagged++;
          // Update reason if it changed
          const newReason = result.recommendation === 'skip'
            ? `Roundup article: ${result.otherShows.length} other shows mentioned 3+ times (${result.otherShows.slice(0, 3).map(s => s.title).join(', ')})`
            : `Comparison article: "${result.otherShows[0].title}" mentioned ${result.otherShows[0].mentions} times`;
          if (!dryRun && newReason !== data.multiShowReason) {
            data.multiShowReason = newReason;
            fs.writeFileSync(fullPath, JSON.stringify(data, null, 2) + '\n');
          }
        }
      } catch (e) {
        errors++;
        if (verbose) console.error(`Error processing ${fullPath}: ${e.message}`);
      }
    }
  }
}

console.log(`${dryRun ? '[DRY RUN] ' : ''}Cleaning up stale isMultiShowReview flags...`);
walkDir(reviewTextsDir);

console.log(`\nResults:`);
console.log(`  Total flagged: ${total}`);
console.log(`  Cleared (stale): ${cleared}`);
console.log(`  Still flagged: ${stillFlagged}`);
if (errors) console.log(`  Errors: ${errors}`);
if (dryRun) console.log(`\nRe-run without --dry-run to apply changes.`);
