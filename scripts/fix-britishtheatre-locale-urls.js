#!/usr/bin/env node
// BRO-8017: rewrite locale-prefixed britishtheatre.com /posts/ URLs in review-texts.
// Usage: node scripts/fix-britishtheatre-locale-urls.js [--dir=<review-texts dir>] [--apply]
// Rewritten files get urlCorrectedFrom + needsRefetch so the collector refetches despite existing text.
const fs = require('fs'), path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { listShowDirs } = require('./lib/list-show-dirs');
const { canonicalBritishTheatreUrl, hasBritishTheatreLocalePrefix } = require('./lib/britishtheatre-locale-url');
const dir = (process.argv.find(a => a.startsWith('--dir=')) || '').slice(6) || path.join(__dirname, '..', 'data', 'review-texts');
const apply = process.argv.includes('--apply');
const changed = [];
for (const show of listShowDirs(dir, { silent: true })) {
  const sd = path.join(dir, show);
  for (const f of fs.readdirSync(sd)) {
    if (!/^britishtheatrecom--.*\.json$/.test(f)) continue;
    const p = path.join(sd, f);
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!hasBritishTheatreLocalePrefix(d.url)) continue;
    const before = d.url; d.url = canonicalBritishTheatreUrl(before);
    d.urlCorrectedFrom = before; d.needsRefetch = true; // standard refetch markers (url-corrected-refetch.js)
    delete d.fetchRetryAfter;
    delete d.fetchDiscoveryAbandoned; // abandoned flag was set against the locale URL and blocks refetch
    changed.push(`${show}/${f}`);
    if (apply) safeWriteReview(p, d);
  }
}
console.log(`${apply ? 'rewrote' : 'would rewrite'} ${changed.length} files`);
console.log(changed.join('\n'));
