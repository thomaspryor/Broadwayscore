#!/usr/bin/env node
'use strict';
/**
 * find-url-owners.js (BRO-5501): read-only. Lists every review-text file that
 * holds a URL, with the flags that decide who wins the rebuild's cross-show URL
 * dedup. Built for cloud sessions that read review-texts via cloud-run-script.js.
 *
 *   node scripts/find-url-owners.js --url=<url>
 *
 * Env: REVIEW_TEXTS_DIR (default data/review-texts).
 */
const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { normalizeUrl } = require('./lib/stale-slot-squatters');
const { hasHelpFlag } = require('./lib/cli-help.js');

const argv = process.argv.slice(2);
const a = argv.find((x) => x.startsWith('--url='));
if (hasHelpFlag(argv) || !a) { console.log('find-url-owners.js --url=<url>'); process.exit(hasHelpFlag(argv) ? 0 : 2); }
const want = normalizeUrl(a.slice(6));
const ROOT = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
let n = 0;
for (const showId of listShowDirs(ROOT)) {
  const dir = path.join(ROOT, showId);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!d.url || normalizeUrl(d.url) !== want) continue;
    n++;
    const flags = ['wrongProduction', 'wrongShow', 'duplicateOf', 'isMultiShowReview', 'isMultiShowSplitParent', 'isMultiShowSplitChild', 'multiShowSplitProcessed', 'isRoundupArticle', 'nonReview']
      .filter((k) => d[k]).map((k) => `${k}=${typeof d[k] === 'object' ? JSON.stringify(d[k]) : d[k]}`);
    console.log(JSON.stringify({ showId, file: f, publishDate: d.publishDate, flags }));
  }
}
console.log(`${n} file(s) hold ${want}`);
