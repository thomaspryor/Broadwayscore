#!/usr/bin/env node
'use strict';
/**
 * Correct review publishDates that were stored one day LATE because a UTC timestamp was
 * truncated instead of converted to the publisher's local calendar date (BRO-5499; fixed at
 * source in lib/local-date.js).
 *
 * Evidence required, per file: the article URL carries a /YYYY/MM/DD/ permalink (a CMS writes
 * the post's local date there) AND the stored publishDate is exactly that date + 1 day AND the file
 * came from a collector that stamps UTC-truncated timestamps (UTC_STAMPING_SOURCES). Skips
 * files with a human-verified dateSource, _locked records, and anything else. Writes
 * publishDate, dateSource 'permalink-corrected-utc-shift' and publishDateWas.
 *
 *   node scripts/fix-utc-shifted-publish-dates.js [--show=ID] [--since=YYYY-MM-DD] [--apply] [--strict]
 *
 * --since limits to files whose stored publishDate is on/after that date (default: all).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RT = path.join(ROOT, 'data', 'review-texts');
const SKIP_SOURCES = new Set(['human-page-verified', 'human', 'manual']);
// Only collectors that stamp a UTC-truncated page/feed/roundup timestamp. Aggregator-supplied dates (Show
// Score, DTLI, NYC Theatre, BWW /reviews/, WestEndTheatre) and legacy rows may be print dates entered by
// hand; they are left alone.
const UTC_STAMPING_SOURCES = new Set([
  'rss-discovery', 'outlet-listing-poller', 'opening-night-discovery', 'google-news-rss', 'submit-review-form',
  'serp-discovery', 'outlet-serp-discovery', 'broad-web-serp', 'web-search', 'bww-roundup', 'playbill-verdict',
]);
const DAY = 86400000;

/** Pure: the corrected date for one review record, or null when the evidence is not there. */
function utcShiftCorrection(rec) {
  if (!rec || rec._locked) return null;
  const pub = String(rec.publishDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const url = String(rec.url || '').match(/\/(20\d{2})\/(\d{2})\/(\d{2})\//);
  if (!pub || !url) return null;
  if (SKIP_SOURCES.has(rec.dateSource) || rec.humanReviewedDate === true) return null;
  if (!UTC_STAMPING_SOURCES.has(rec.source)) return null;
  // A record a plan already edited (approvedFixes) carries a human decision.
  if (Array.isArray(rec.approvedFixes) && rec.approvedFixes.length) return null;
  const p = Date.UTC(+pub[1], +pub[2] - 1, +pub[3]);
  const u = Date.UTC(+url[1], +url[2] - 1, +url[3]);
  if (Number.isNaN(u) || +url[2] < 1 || +url[2] > 12 || +url[3] < 1 || +url[3] > 31) return null;
  if (p - u !== DAY) return null;
  return `${url[1]}-${url[2]}-${url[3]}`;
}

function main() {
  require('./lib/cli-help').exitOnHelp(module);
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const only = (args.find((a) => a.startsWith('--show=')) || '').slice(7) || null;
  const since = (args.find((a) => a.startsWith('--since=')) || '').slice(8) || null;
  let changed = 0;
  const bySource = {};
  for (const sd of fs.readdirSync(RT)) {
    if (only && sd !== only) continue;
    const dir = path.join(RT, sd);
    let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(dir, f);
      let rec; try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (since && String(rec.publishDate || '') < since) continue;
      const fixed = utcShiftCorrection(rec);
      if (!fixed) continue;
      changed++;
      bySource[rec.source || '?'] = (bySource[rec.source || '?'] || 0) + 1;
      if (!apply) continue;
      rec.publishDateWas = rec.publishDate;
      rec.publishDate = fixed;
      rec.dateSource = 'permalink-corrected-utc-shift';
      fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n');
    }
  }
  console.log(`[fix-utc-shifted-publish-dates] ${changed} files ${apply ? 'CORRECTED' : '(dry run, use --apply)'}`);
  console.log(JSON.stringify(bySource));
  // --strict (CI audit): exit 1 while any file still carries a UTC-shifted date.
  if (args.includes('--strict') && !apply && changed > 0) process.exit(1);
}

module.exports = { utcShiftCorrection };
if (require.main === module) main();
