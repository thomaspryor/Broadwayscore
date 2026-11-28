#!/usr/bin/env node
/**
 * Weekly Broadway Journal sweep (BRO-6167).
 *
 * Broadway Journal (Substack) quotes NY AG financial filings, but the commercial
 * pipeline only reads headlines of the newest posts and the hourly poller only
 * matches "recoup" in titles. This walks the WHOLE Substack archive, scans each
 * post body for filing/financial terms, diffs against URLs already cited in
 * data/commercial.json, and routes uncited posts to a human via ONE aggregate
 * routeAlert. It never writes commercial.json.
 *
 * Posts dated before --before (default 2026-10-24) are the BRO-6160 backfill's
 * job and are reported but never alerted.
 *
 * Usage:
 *   node scripts/sweep-broadway-journal.js --dry-run     # scan + print, no alert
 *   node scripts/sweep-broadway-journal.js               # scan + alert if fresh uncited posts
 *   node scripts/sweep-broadway-journal.js --before=2026-10-24 --max-posts=400
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { fetchUrl } = require('./lib/rss-discovery');
const { MAIN_REPO_ROOT } = require('./lib/repo-root');
const { runMain } = require('./lib/run-main');
const bj = require('./lib/broadway-journal');

const flags = {};
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v === undefined ? true : v; }
}
const DRY_RUN = flags['dry-run'] === true;
const BEFORE = flags.before || '2026-10-24';
const MAX_POSTS = parseInt(flags['max-posts'], 10) || 1000;
const BASE = 'https://www.broadwayjournal.com';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function commercialPath() {
  const local = path.join(__dirname, '..', 'data', 'commercial.json');
  if (fs.existsSync(local)) return local;
  return path.join(MAIN_REPO_ROOT, 'data', 'commercial.json');
}
// Substack rate-limits (HTTP 429) a fast walk: back off and retry before giving up.
const fetchJson = async (url, attempts = 5) => {
  for (let i = 0; ; i++) {
    try { return JSON.parse(await fetchUrl(url, 20000)); }
    catch (e) {
      if (i + 1 >= attempts || !/HTTP 429|Timeout/.test(e.message)) throw e;
      await sleep(2000 * 2 ** i);
    }
  }
};

async function main() {
  const cp = commercialPath();
  if (!fs.existsSync(cp)) throw new Error(`data/commercial.json not found (${cp}); attach core data`);
  const cited = bj.citedSlugs(fs.readFileSync(cp, 'utf8'));
  console.log(`Cited Broadway Journal posts in commercial.json: ${cited.size}`);

  const { posts, complete } = await bj.fetchArchive(fetchJson, { base: BASE });
  if (!complete) throw new Error('archive walk hit the page cap; refusing to report from a partial archive');
  console.log(`Archive: ${posts.length} posts`);

  const analyzed = [];
  const unreadable = [];
  // Posts dated before --before belong to the BRO-6160 backfill and are never
  // alerted on, so skip their body fetch (keeps the weekly run short).
  const cutoff = Date.parse(BEFORE);
  const old = posts.filter(p => p.post_date && Date.parse(p.post_date) < cutoff).length;
  console.log(`Skipping ${old} posts dated before ${BEFORE} (BRO-6160 backfill)`);
  for (const p of posts.slice(0, MAX_POSTS)) {
    if (!p.slug || cited.has(p.slug)) continue;
    if (p.post_date && Date.parse(p.post_date) < cutoff) continue;
    let body = '';
    let truncated = p.audience && p.audience !== 'everyone';
    try {
      const full = await fetchJson(`${BASE}/api/v1/posts/${p.slug}`);
      body = bj.stripHtml(full.body_html || '');
      if (full.audience && full.audience !== 'everyone') truncated = true;
    } catch (e) {
      console.log(`  ✗ ${p.slug}: ${e.message}`);
      // A deleted post (404/410) can never be read: do not let it fail every future run.
      if (!/HTTP 404|HTTP 410/.test(e.message)) unreadable.push(p.slug);
      continue;
    }
    const { terms } = bj.scanFinancialTerms(`${p.title || ''} ${p.subtitle || ''} ${body}`);
    analyzed.push({
      slug: p.slug, title: p.title || p.slug, url: p.canonical_url || `${BASE}/p/${p.slug}`,
      postDate: p.post_date || '', audience: p.audience || null, truncated: !!truncated, terms,
    });
    await sleep(400);
  }

  const { fresh, backlog } = bj.selectUncited(analyzed, cited, { before: BEFORE });
  const inconclusive = analyzed.filter(a => a.truncated && a.terms.length === 0).length;
  console.log(`Scanned ${analyzed.length} uncited posts | uncited w/ financial terms: ${fresh.length} new, ${backlog.length} before ${BEFORE} (BRO-6160 backfill) | paywalled/inconclusive: ${inconclusive}`);
  for (const a of fresh) console.log(`  NEW ${a.postDate.slice(0, 10)} ${a.title} [${a.terms.join(', ')}]\n      ${a.url}`);
  for (const a of backlog.slice(0, 5)) console.log(`  backlog ${a.postDate.slice(0, 10)} ${a.title}`);

  if (inconclusive > 0) console.warn(`WARNING: ${inconclusive} paywalled post(s) had no matching terms in the visible text; they could not be fully scanned.`);
  if (!DRY_RUN) {
    const router = require('./lib/owner-alert-router');
    if (fresh.length > 0) {
      const res = await router.routeAlert(bj.sweepAlertOpts(fresh));
      console.log(`Alert routed: ${res && res.action}`);
      if (res && (res.dispatchOk === false || res.dispatchError)) throw new Error(`alert card was not filed: ${res.dispatchError || 'dispatch failed'}`);
    } else if (unreadable.length === 0) {
      console.log('Nothing new to report.');
      router.resolveCondition(bj.SWEEP_CONDITION_KEY, { reason: 'no uncited financial posts' });
    } else {
      console.log('Nothing new to report, but some posts were unreadable; leaving the alert condition open.');
    }
  } else {
    console.log('[dry-run] no alert sent');
  }

  // A post we could not read is a post we did not scan. Report what we found
  // first, then fail the run so the notify-failure step fires.
  if (unreadable.length > 0) throw new Error(`${unreadable.length} post(s) unreadable after retries (${unreadable.slice(0, 3).join(', ')}...); sweep incomplete`);
}

if (require.main === module) runMain(main);
module.exports = { main };
