#!/usr/bin/env node
/**
 * outlet-registry-census-reconciler.js — review URLs the SERP census found
 * for a show whose domain has NO outlet-registry.json entry (BRO-2731).
 *
 * Why: a review on an unregistered domain is invisible to the pipeline.
 * Discovery never fetches it and no stage-latency.jsonl event is written, so
 * coverage telemetry cannot even count it as missing. On electra-persona
 * (2026-09-01) two T3 reviews (a wordpress.com and a blogspot.com blog) were
 * found only by a hand-run web search during the opening-night monitor.
 *
 * What it does: takes the census URL union for one show (every arm of
 * scripts/audit-serp-census-recall.js), keeps the review-shaped ones
 * (classifyReviewUrl ok, not isBlockedReviewUrl), and reports each whose host
 * is not a registered outlet domain/domainAlias, marking the ones already on
 * disk. Syndication portals (news.yahoo.com etc.) are skipped: their host
 * never names the publisher.
 *
 * Source of URLs:
 *   default  data/audit/serp-census-recall.json (the census cron's last
 *            report; free, but only covers the shows that run sampled)
 *   --live   runs audit-serp-census-recall.js --shows=<id> into a temp file
 *            first (spends SERP credits; needs the SERP provider keys)
 *
 * Usage:
 *   node scripts/outlet-registry-census-reconciler.js --show=<id> [--live] [--json] [--strict]
 *   node scripts/outlet-registry-census-reconciler.js --all     # every show in the report
 *     (audit-census-recall.yml runs this after each census, into the step summary)
 *   --report=PATH  read a different census report
 *   --strict       exit 1 when any unregistered review URL is not yet on disk
 * Exit 2: the show is not in the report (re-run with --live).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { classifyReviewUrl } = require('./lib/non-review-url-patterns');
const { isBlockedReviewUrl } = require('./lib/domain-filters');
const { isSyndicationPortalHost } = require('./lib/review-normalization');

const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.join(__dirname, '..');
const DEFAULT_REPORT = path.join(ROOT, 'data', 'audit', 'serp-census-recall.json');

function hostOf(url) {
  try { return new URL(url).hostname.replace(/\.+$/, '').replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

/** Every registered outlet domain and domainAlias, lower-case, no www. */
function registeredHosts(registry) {
  const hosts = new Set();
  for (const [id, o] of Object.entries((registry && registry.outlets) || {})) {
    if (id.startsWith('_') || !o || typeof o !== 'object') continue;
    for (const d of [o.domain, ...(o.domainAliases || [])]) {
      if (typeof d === 'string' && d) hosts.add(d.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''));
    }
  }
  return hosts;
}

/** A host is registered when it, or a parent domain of it, is. */
function isRegisteredHost(host, hosts) {
  const parts = String(host || '').split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (hosts.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

/** Census URL union for one show-report row: every arm's urls. */
function censusUrlsForShow(row) {
  const out = new Set();
  for (const arm of (row && row.arms) || []) for (const u of arm.urls || []) out.add(u);
  for (const u of (row && row.newFromNaive) || []) out.add(u);
  return [...out];
}

/**
 * @param {string[]} urls census URLs
 * @param {Set<string>} hosts registeredHosts(registry)
 * @param {Set<string>} [onDisk] normalized review URLs already stored for the show
 * @param {(u: string) => string} [normalize]
 * @param {Set<string>|Map<string,string>} [pending] normalized urls parked in
 *   data/review-texts/_pending/<show>/ (Map values 'pending' | 'rejected')
 * @returns {{url: string, host: string, onDisk: boolean, pending: boolean}[]}
 */
function findUnregisteredCensusUrls(urls, hosts, onDisk = new Set(), normalize = u => u, pending = new Set()) {
  const out = [];
  const seen = new Set();
  for (const url of urls) {
    const host = hostOf(url);
    if (!host || seen.has(url)) continue;
    seen.add(url);
    if (!classifyReviewUrl(url).ok || isBlockedReviewUrl(url)) continue;
    if (isSyndicationPortalHost(host)) continue;
    if (isRegisteredHost(host, hosts)) continue;
    const key = normalize(url);
    // pending: a Set of urls, or a Map url -> 'pending' | 'rejected'.
    const pendingState = pending instanceof Map ? (pending.get(key) || null) : (pending.has(key) ? 'pending' : null);
    out.push({ url, host, onDisk: onDisk.has(key), pending: pendingState === 'pending', ...(pendingState === 'rejected' ? { rejected: true } : {}) });
  }
  return out.sort((a, b) => a.host.localeCompare(b.host) || a.url.localeCompare(b.url));
}

/**
 * State of each url parked in data/review-texts/_pending/<show>/: 'rejected'
 * when the parker judged it not this show's review (rssIdentityRejected,
 * wrongProduction), else 'pending'. Either way it was fetched, not missed.
 */
function pendingUrlStates(showId, normalize, reviewTextsDir = path.join(ROOT, 'data', 'review-texts')) {
  const out = new Map();
  const dir = path.join(reviewTextsDir, '_pending', showId);
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!rec || !rec.url) continue;
    const key = normalize(rec.url);
    const state = rec.rssIdentityRejected === true || rec.wrongProduction === true ? 'rejected' : 'pending';
    if (out.get(key) !== 'pending') out.set(key, state);
  }
  return out;
}

function getArg(name) {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

const USAGE = `Usage: node scripts/outlet-registry-census-reconciler.js --show=<id>|--all [--live] [--json] [--strict] [--report=PATH]
Lists SERP-census review URLs whose domain has no outlet-registry.json entry (BRO-2731).
  --show=<id>    one show from the census report
  --all          every show in the report
  --live         run the census for --show first (spends SERP credits)
  --json         machine-readable output
  --strict       exit 1 when an unregistered review URL is not on disk
  --report=PATH  read a different census report (default data/audit/serp-census-recall.json)`;

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const showId = getArg('show');
  const all = process.argv.includes('--all');
  if (!showId && !all) {
    console.error('Usage: node scripts/outlet-registry-census-reconciler.js --show=<id>|--all [--live] [--json] [--strict] [--report=PATH]');
    process.exit(2);
  }
  if (all && process.argv.includes('--live')) {
    console.error('--live needs --show=<id> (--all reads the last census report)');
    process.exit(2);
  }
  let reportPath = getArg('report') || DEFAULT_REPORT;
  if (process.argv.includes('--live')) {
    reportPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'census-reconcile-')), 'report.json');
    const r = spawnSync(process.execPath, [path.join(__dirname, 'audit-serp-census-recall.js'), `--shows=${showId}`, `--out=${reportPath}`], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) {
      console.error(`census run failed (exit ${r.status})`);
      process.exit(1);
    }
  }
  let report;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch (e) {
    console.error(`cannot read census report ${reportPath}: ${e.message}`);
    process.exit(2);
  }
  const rows = all ? (report.shows || []) : (report.shows || []).filter(s => s.showId === showId);
  if (!rows.length) {
    console.error(`${showId || 'no show'} is not in ${path.relative(ROOT, reportPath)} (generated ${report.generatedAt || '?'}, ${(report.shows || []).length} shows). Re-run with --live.`);
    process.exit(all ? 0 : 2);
  }
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'outlet-registry.json'), 'utf8'));
  const hosts = registeredHosts(registry);
  const { onDiskUrls } = require('./audit-serp-census-recall.js');
  const { normalizeReviewUrl } = require('./audit-show-review-gap.js');
  const results = rows.map(row => {
    const urls = censusUrlsForShow(row);
    // A fetched review parked in _pending/<show>/ was fetched, not missed: it
    // waits on review there (BRO-5261 retro of BRO-2731; hound-of-the-
    // baskervilles brawtheatre/yeahlifestyle read MISSING while pending).
    const pending = pendingUrlStates(row.showId, normalizeReviewUrl);
    return { showId: row.showId, censusUrls: urls.length, unregistered: findUnregisteredCensusUrls(urls, hosts, onDiskUrls(row.showId), normalizeReviewUrl, pending) };
  });
  const isMissing = h => !h.onDisk && !h.pending && !h.rejected;
  const missingTotal = results.reduce((n, r) => n + r.unregistered.filter(isMissing).length, 0);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ reportGeneratedAt: report.generatedAt || null, shows: results }, null, 2));
  } else {
    for (const r of results) {
      const missing = r.unregistered.filter(isMissing).length;
      console.log(`${r.showId}: ${r.censusUrls} census URL(s) (report ${report.generatedAt || '?'}), ${r.unregistered.length} review-shaped on an unregistered domain, ${missing} not on disk`);
      for (const h of r.unregistered) console.log(`  ${h.onDisk ? 'on disk ' : h.pending ? 'pending ' : h.rejected ? 'rejected' : 'MISSING '} ${h.host}  ${h.url}`);
    }
    if (missingTotal) console.log('\nNot on disk = the pipeline never fetched it (pending = fetched, parked in _pending/ for review; rejected = fetched, judged not a review of this show). Register the outlet (data/outlet-registry.json) or ingest the URL (scripts/ingest-review-from-url.js).');
  }
  process.exit(process.argv.includes('--strict') && missingTotal ? 1 : 0);
}

if (require.main === module) main();

module.exports = { registeredHosts, isRegisteredHost, censusUrlsForShow, findUnregisteredCensusUrls, pendingUrlStates };
