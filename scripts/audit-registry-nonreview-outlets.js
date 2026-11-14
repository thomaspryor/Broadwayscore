#!/usr/bin/env node
/**
 * audit-registry-nonreview-outlets.js — one-time cross-check (BRO-2716).
 *
 * BRO-2712 found two outlets (a venue listing page, a PR firm's press
 * release) that --update had registered as review outlets. The registry was
 * auto-populated long before those domain guards existed, so this sweeps
 * EVERY registered outlet's host through the same predicates the write path
 * uses today: domain-filters.js isBlockedReviewUrl (venue, PR firm, ticketing,
 * aggregator, social, reference ...) and non-review-url-patterns.js
 * classifyReviewUrl's host-level rules. It also counts, per outlet, how many
 * of its review-text URLs isBlockedReviewUrl refuses.
 *
 * REPORT ONLY. It never edits the registry: a wrong removal would silently
 * drop scored reviews from an outlet whose domain merely collides with a list.
 *
 * Usage:
 *   node scripts/audit-registry-nonreview-outlets.js          # table
 *   node scripts/audit-registry-nonreview-outlets.js --json   # machine-readable
 */
const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { isBlockedReviewUrl } = require('./lib/domain-filters');
const nonReview = require('./lib/non-review-url-patterns');
const { inferOutletDomainHint } = require('./lib/outlet-domain-hint');
const { resolveReviewTextsDir, isReviewTextsCheckout } = require('./lib/review-texts-dir');

const REPO = path.join(__dirname, '..');
// Host-level rules only: classifyReviewUrl's path rules (e.g. /news/) say
// nothing about whether the HOST is a review outlet, and its bare /\.org$/
// catch-all is a discovery-census heuristic (it flags WNYC, WBUR, DC Theater
// Arts ...), not evidence that a registered outlet is a venue.
const HOST_PATTERNS = nonReview.NON_REVIEW_HOST_PATTERNS.filter(rx => rx.source !== '\\.org$');

/** classifyReviewUrl's verdict came only from the bare /\.org$/ catch-all. */
function isOrgCatchAllOnly(bare) {
  const reg = nonReview.registrableHost(bare);
  return /\.org$/.test(reg) && !HOST_PATTERNS.some(rx => rx.test(bare) || rx.test(reg));
}

/**
 * Why `host` is not a review outlet, or [] when nothing flags it. The two
 * write-path predicates run on the host's root url, so every host rule they
 * hold (subdomains, named ticketing/listing hosts) applies here unchanged.
 * @param {string} host bare hostname, e.g. "southbankcentre.co.uk"
 * @returns {string[]}
 */
function nonReviewHostReasons(host) {
  if (!host) return [];
  const bare = String(host).replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase();
  if (!bare) return [];
  // A neutral article path: host-wide rules fire, homepage and section-path rules do not.
  const url = `https://${bare}/article/review-x-20260101`;
  const reasons = [];
  if (isBlockedReviewUrl(url)) reasons.push('isBlockedReviewUrl');
  const verdict = nonReview.classifyReviewUrl(url);
  if (!verdict.ok && verdict.reason && !(verdict.reason === 'non-review-host' && isOrgCatchAllOnly(bare))) reasons.push(verdict.reason);
  return reasons;
}

// Copies the rebuild never scores: they say nothing about the outlet's own urls.
const EXCLUDED_COPY_FLAGS = ['duplicateOf', 'crossOutletDuplicate', 'wrongShow', 'wrongProduction', 'isNonReview', 'isNotReview', 'wrongAttribution', 'rejectedAt', 'rejectionReason'];

/**
 * Registry entries whose host is flagged, or most of whose review URLs are.
 * @param {object} registry parsed outlet-registry.json
 * @param {Map<string,string[]>} urlsByOutlet outletId -> review-text URLs
 */
function findNonReviewRegistryOutlets(registry, urlsByOutlet) {
  const hits = [];
  for (const [id, entry] of Object.entries(registry.outlets || {})) {
    if (id.startsWith('_') || !entry || typeof entry !== 'object') continue;
    const urls = urlsByOutlet.get(id) || [];
    const host = entry.domain || inferOutletDomainHint(urls) || null;
    const hosts = [host, ...(entry.domainAliases || [])].filter(Boolean);
    const reasons = [...new Set(hosts.flatMap(nonReviewHostReasons))];
    const blockedUrls = urls.filter(u => isBlockedReviewUrl(u)).length;
    const mostUrlsBlocked = urls.length > 0 && blockedUrls * 2 >= urls.length;
    if (reasons.length || mostUrlsBlocked) {
      hits.push({ outletId: id, displayName: entry.displayName, tier: entry.tier, host, reasons, reviewFiles: urls.length, blockedUrls });
    }
  }
  return hits.sort((a, b) => a.outletId.localeCompare(b.outletId));
}

function collectUrlsByOutlet(reviewTextsDir) {
  const byOutlet = new Map();
  for (const show of listShowDirs(reviewTextsDir, { silent: true, skipHolding: true })) {
    const dir = path.join(reviewTextsDir, show);
    for (const f of fs.readdirSync(dir)) {
      if (!isReviewTextFile(f)) continue;
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      const id = r.outletId || (f.match(/^(.+?)--/) || [])[1];
      if (!id || !r.url || EXCLUDED_COPY_FLAGS.some(k => r[k])) continue;
      if (!byOutlet.has(id)) byOutlet.set(id, []);
      byOutlet.get(id).push(r.url);
    }
  }
  return byOutlet;
}

if (require.main === module) {
  const registry = JSON.parse(fs.readFileSync(path.join(REPO, 'data/outlet-registry.json'), 'utf8'));
  const textsDir = resolveReviewTextsDir();
  const byOutlet = isReviewTextsCheckout(textsDir) ? collectUrlsByOutlet(textsDir) : new Map();
  if (byOutlet.size === 0) console.error(`warning: no review-texts checkout at ${textsDir}; checking registry domains only`);
  const hits = findNonReviewRegistryOutlets(registry, byOutlet);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(hits, null, 2));
  } else {
    console.log(`${hits.length} registered outlet(s) flagged by today's non-review domain predicates:`);
    for (const h of hits) {
      console.log(`  ${h.outletId} (${h.displayName}, T${h.tier}) host=${h.host} reasons=[${h.reasons.join(', ')}] files=${h.reviewFiles} blockedUrls=${h.blockedUrls}`);
    }
  }
}

module.exports = { nonReviewHostReasons, findNonReviewRegistryOutlets };
