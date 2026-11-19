#!/usr/bin/env node
'use strict';
/**
 * Recheck recent review urls (BRO-7841). An outlet pulled a review we linked (TheaterScene / IAWL 2026-11-19).
 * Re-fetches the urls of reviews published in the last N days (default 3) and, when a url is gone (404/410 on
 * two probes), marks the record urlDead so the rebuild publishes the review without its link. A withheld record
 * whose url is live again is restored. Needs data/review-texts (CI checkout).
 *
 * Usage: node scripts/recheck-recent-review-urls.js [--apply] [--days=3] [--show=ID] [--time-budget-sec=240]
 * Hosted in rebuild-reviews.yml, right before the rebuild, so a marker is pushed with the same run.
 * Writes `marked`/`restored` counts to $GITHUB_OUTPUT. Exit 0 always except bad usage (2).
 */
const fs = require('fs');
const path = require('path');
const { recheck } = require('./lib/recheck-review-urls');

async function fetchStatus(url) {
  const { fetchPage } = require('./lib/scraper');
  try {
    await fetchPage(url, { directOnly: true, skipVerify: true });
    return 200;
  } catch (e) {
    const m = /failed: (\d{3})/.exec(String(e && e.message));
    return m ? Number(m[1]) : null; // timeouts, DNS, blocks: no evidence
  }
}

(async () => {
  const args = process.argv.slice(2);
  const get = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
  const apply = args.includes('--apply');
  const days = Number(get('days', '3'));
  if (!Number.isFinite(days) || days <= 0) { console.error('bad --days'); process.exit(2); }
  const dir = path.join(__dirname, '..', 'data', 'review-texts');
  if (!fs.existsSync(dir)) { console.log('no data/review-texts, nothing to recheck'); process.exit(0); }
  const res = await recheck({
    reviewTextsDir: dir, probe: fetchStatus, apply, hours: days * 24, onlyShow: get('show'),
    budgetMs: Number(get('time-budget-sec', '240')) * 1000, log: (m) => console.log(m),
  });
  console.log(`dead-link recheck: ${res.checked}/${res.candidates} checked, ${res.marked.length} gone, ${res.restored.length} restored${apply ? '' : ' (dry run)'}`);
  for (const m of res.marked) console.log(`  GONE ${m.show}/${m.file} ${m.url} (${m.status})`);
  for (const r of res.restored) console.log(`  LIVE AGAIN ${r.show}/${r.file} ${r.url}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `marked=${res.marked.length}\nrestored=${res.restored.length}\n`);
})().catch((e) => { console.error(e); process.exit(0); });
