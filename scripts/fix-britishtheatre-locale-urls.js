#!/usr/bin/env node
// BRO-8017: rewrite locale-prefixed britishtheatre.com /posts/ URLs in review-texts.
// Usage: node scripts/fix-britishtheatre-locale-urls.js [--dir=<review-texts dir>] [--apply]
// Rewritten files are marked for refetch (fetchRetryAfter cleared, textStatus left for collector via forceRefetch list printed).
const fs = require('fs'), path = require('path');
const { canonicalBritishTheatreUrl, hasBritishTheatreLocalePrefix } = require('./lib/britishtheatre-locale-url');
const dir = (process.argv.find(a => a.startsWith('--dir=')) || '').slice(6) || path.join(__dirname, '..', 'data', 'review-texts');
const apply = process.argv.includes('--apply');
const changed = [];
for (const show of fs.readdirSync(dir)) {
  const sd = path.join(dir, show);
  if (!fs.statSync(sd).isDirectory()) continue;
  for (const f of fs.readdirSync(sd)) {
    if (!/^britishtheatrecom--.*\.json$/.test(f)) continue;
    const p = path.join(sd, f);
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!hasBritishTheatreLocalePrefix(d.url)) continue;
    const before = d.url; d.url = canonicalBritishTheatreUrl(before);
    d._urlLocaleRewrittenFrom = before;
    delete d.fetchRetryAfter;
    delete d.fetchDiscoveryAbandoned; // abandoned flag was set against the locale URL and blocks refetch
    changed.push(`${show}/${f}`);
    if (apply) fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
  }
}
console.log(`${apply ? 'rewrote' : 'would rewrite'} ${changed.length} files`);
console.log(changed.join('\n'));
