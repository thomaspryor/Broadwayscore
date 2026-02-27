#!/usr/bin/env node

/**
 * One-time cleanup: reclassify not_attempted review files with objectively
 * unfetchable URLs (relative paths, social media, Wikipedia, malformed).
 *
 * Usage:
 *   node scripts/cleanup-unfetchable-urls.js --dry-run   # preview changes
 *   node scripts/cleanup-unfetchable-urls.js              # apply changes
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const reviewTextsDir = path.join(__dirname, '..', 'data', 'review-texts');

const SOCIAL_DOMAINS = ['facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com', 'youtu.be', 'reddit.com', 'tiktok.com'];
const NON_REVIEW_DOMAINS = ['wikipedia.org', 'en.wikipedia.org'];

const results = { relative: [], social: [], nonReview: [], malformed: [], total: 0 };

const showDirs = fs.readdirSync(reviewTextsDir, { withFileTypes: true })
  .filter(d => d.isDirectory()).map(d => d.name);

for (const showDir of showDirs) {
  const showPath = path.join(reviewTextsDir, showDir);
  const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  for (const file of files) {
    const filePath = path.join(showPath, file);
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }

    if (data.incompleteReason !== 'not_attempted') continue;
    results.total++;

    const url = data.url;
    if (!url) continue;

    let category = null;
    let newReason = null;
    let detail = null;

    // 1. Relative/fragment URLs (no protocol)
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      category = 'relative';
      newReason = 'no_url';
      detail = `Invalid/relative URL: ${url.substring(0, 80)}`;
    } else {
      let hostname;
      try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch {
        category = 'malformed';
        newReason = 'no_url';
        detail = `Malformed URL: ${url.substring(0, 80)}`;
      }

      if (!category && hostname) {
        // 2. Social media
        if (SOCIAL_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) {
          category = 'social';
          newReason = 'wrong_content';
          detail = `Social media URL (${hostname})`;
        }
        // 3. Wikipedia / non-review
        else if (NON_REVIEW_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) {
          category = 'nonReview';
          newReason = 'wrong_content';
          detail = `Non-review URL (${hostname})`;
        }
        // 4. archive.org URLs (CDX lookup would be circular)
        else if (hostname === 'web.archive.org' || hostname === 'archive.org') {
          category = 'nonReview';
          newReason = 'wrong_content';
          detail = `Archive.org URL — not an original review`;
        }
      }
    }

    if (!category) continue;

    results[category].push(`${showDir}/${file} → ${newReason} (${detail})`);

    if (!DRY_RUN) {
      data.incompleteReason = newReason;
      data.incompleteDetail = detail;
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
    }
  }
}

const totalFixed = results.relative.length + results.social.length + results.nonReview.length + results.malformed.length;

console.log(`\n${DRY_RUN ? '=== DRY RUN ===' : '=== APPLIED ==='}`);
console.log(`Total not_attempted files scanned: ${results.total}`);
console.log(`\nRelative/fragment URLs (→ no_url): ${results.relative.length}`);
for (const r of results.relative) console.log(`  ${r}`);
console.log(`\nSocial media URLs (→ wrong_content): ${results.social.length}`);
for (const r of results.social) console.log(`  ${r}`);
console.log(`\nNon-review URLs (→ wrong_content): ${results.nonReview.length}`);
for (const r of results.nonReview) console.log(`  ${r}`);
console.log(`\nMalformed URLs (→ no_url): ${results.malformed.length}`);
for (const r of results.malformed) console.log(`  ${r}`);
console.log(`\nTotal reclassified: ${totalFixed}`);
