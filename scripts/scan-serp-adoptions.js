#!/usr/bin/env node
'use strict';

/**
 * scan-serp-adoptions.js — corpus sweep for BRO-4409. Re-evaluates every
 * review file whose url was adopted by SERP rediscovery (urlDiscoveryMethod
 * google-serp*, scrapingdog*, wrongUrl-serp-retry) with the current
 * evaluateSerpAcceptance predicate, including the review-slug-downgrade check
 * against data.previousUrl (BRO-4546). A downgrade a human/LLM audit confirmed
 * benign (the new URL serves the same critic's review) carries
 * serpDowngradeVerifiedUrl === url and is exempt from that one check; a later
 * url change makes the stamp stale automatically.
 *
 *   node scripts/scan-serp-adoptions.js [--root=DIR] [--fix] [--reason=PREFIX]
 *
 * --reason limits reporting and --fix to rejects whose reason starts with
 * PREFIX (e.g. --reason=review-slug-downgrade). For that class, audit the
 * stored text FIRST and stamp serpDowngradeVerifiedUrl on files whose current
 * url serves the critic's review: --fix blacklists the current url
 * (serpRejectedUrls) and does not check the restored url is live (BRO-4546).
 *
 * A reject is REPAIRED when reverted to a previousUrl that itself passes the
 * predicate (--fix does this via updateFileUrlWithInvariant, aggregator fields
 * kept; it stamps urlDiscoveryMethod 'serp-rejected-non-review', non-empty so
 * Phase 3 skips the file, and records the bad URL in serpRejectedUrls).
 * A reject with no restorable previousUrl is CONTAINED when data/reviews.json
 * carries no entry for that show/outlet/critic (already excluded from scores);
 * it is reported, not counted. Exit 0 when 0 rejects are still LIVE in
 * reviews.json, else 1.
 */

const fs = require('fs');
const path = require('path');
const { evaluateSerpAcceptance } = require('./lib/serp-review-acceptance');
const { updateFileUrlWithInvariant } = require('./lib/url-change-invariant');
const { AGGREGATOR_FIELDS } = require('./lib/rediscovery-candidate');

const REVERTED_METHOD = 'serp-rejected-non-review';
const SERP_METHOD_RE = /^(google-serp|scrapingdog|wrongUrl-serp)/;

function normUrl(u) {
  return String(u || '').trim().replace(/^https?:\/\/(www\.)?/i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
}

function evaluateFile(data, showTitle) {
  if (!data || !SERP_METHOD_RE.test(data.urlDiscoveryMethod || '')) return null;
  if (!data.url) return null;
  const previousUrl = data.serpDowngradeVerifiedUrl === data.url ? undefined : data.previousUrl;
  return evaluateSerpAcceptance({ url: data.url, showTitle, previousUrl });
}

function main() {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  const rootArg = args.find(a => a.startsWith('--root='));
  const reasonArg = args.find(a => a.startsWith('--reason='));
  const reasonPrefix = reasonArg ? reasonArg.slice(9) : '';
  const root = rootArg ? rootArg.slice(7) : path.join(process.cwd(), 'data/review-texts');
  const shows = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/shows.json'), 'utf8')).shows;
  const titleById = new Map(shows.map(s => [s.id, s.title]));

  const reviewsRaw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/reviews.json'), 'utf8'));
  const liveKey = (r) => `${r.showId}|${r.outletId}|${String(r.criticName || '').toLowerCase()}`;
  const live = new Set((reviewsRaw.reviews || reviewsRaw).map(liveKey));

  let scanned = 0;
  const rejects = [];
  const urlOwners = new Map();
  for (const dir of fs.readdirSync(root)) {
    const d = path.join(root, dir);
    if (!fs.statSync(d).isDirectory() || dir.startsWith('_')) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(d, f);
      let data;
      try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      const nu = normUrl(data && data.url);
      if (nu) (urlOwners.get(nu) || urlOwners.set(nu, []).get(nu)).push(`${dir}/${f}`);
      const res = evaluateFile(data, titleById.get(data.showId || dir));
      if (!res) continue;
      scanned++;
      if (!res.ok && res.reason.startsWith(reasonPrefix)) rejects.push({ fp, rel: `${dir}/${f}`, url: data.url, prev: data.previousUrl, reason: res.reason, prevRejected: Array.isArray(data.serpRejectedUrls) ? data.serpRejectedUrls : [], title: titleById.get(data.showId || dir), live: live.has(liveKey(data)) });
    }
  }

  let unrepaired = 0;
  let contained = 0;
  let reverted = 0;
  for (const r of rejects) {
    // BRO-4546: a previousUrl another file (other production, show or critic)
    // already holds is a collision, not a restorable review url.
    const prevOwners = (urlOwners.get(normUrl(r.prev)) || []).filter(x => x !== r.rel);
    const prevOk = !!r.prev && prevOwners.length === 0 && evaluateSerpAcceptance({ url: r.prev, showTitle: r.title }).ok;
    let state = 'REJECT   ';
    if (fix && prevOk) {
      const out = updateFileUrlWithInvariant(r.fp, r.prev, {
        urlDiscoveryMethod: REVERTED_METHOD,
        serpRejectedUrls: [...new Set([...(r.prevRejected || []), r.url])],
        urlRevertedAt: new Date().toISOString(),
        urlRevertReason: `serp-acceptance: ${r.reason}`,
      }, { preserveFields: new Set(AGGREGATOR_FIELDS) });
      if (out) { state = 'REVERTED '; reverted++; }
    }
    if (state === 'REJECT   ') {
      if (r.live) { unrepaired++; state = 'LIVE     '; } else { contained++; state = 'CONTAINED'; }
    }
    console.log(`${state} ${r.rel}  ${r.reason}\n           ${r.url}`);
  }
  console.log(`\nscanned ${scanned} serp-adopted files; ${rejects.length} rejects; ${reverted} reverted; ${contained} contained (not in reviews.json, no restorable previousUrl); ${unrepaired} unrepaired-live`);
  process.exit(unrepaired === 0 ? 0 : 1);
}

if (require.main === module) main();
module.exports = { evaluateFile, normUrl, REVERTED_METHOD, SERP_METHOD_RE };
