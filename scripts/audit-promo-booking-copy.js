#!/usr/bin/env node
'use strict';
/**
 * audit-promo-booking-copy.js: read-only corpus sweep for the two ingest
 * defects in BRO-5902 / BRO-5906.
 *
 *   promo      files whose text is booking/deal marketing copy
 *              (detectPromoBookingCopy), e.g. the staybook listing page
 *   blocked    files whose URL is on a blocked (ticket/social/...) domain
 *   show-hub   files whose URL is an aggregator show hub, not a review
 *              (classifyReviewUrl reason 'show-hub'), e.g. DTLI /shows/<slug>/
 *   twins      two or more live files in one show folder with the same URL
 *
 * Each row says whether the file is still live (not already excluded by a
 * flag or an invalid tier). Prints file ids, outlet ids and matched
 * boilerplate phrases only, never review text.
 *
 * Usage:
 *   node scripts/audit-promo-booking-copy.js [--json] [--show=ID] [--counts=PATH]
 * --counts (BRO-6038 shadow job) writes counts only and prints the summary only;
 * findings = live promo + live show-hub rows. Blocked-domain rows are counted
 * beside it, not in findings: rebuild-all-reviews.js drops isBlockedReviewRecord.
 * Exit 0 always (report only). Needs data/review-texts.
 */
const fs = require('fs');
const path = require('path');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { listShowDirs } = require('./lib/list-show-dirs');
const { hasHelpFlag } = require('./lib/cli-help');
const { detectPromoBookingCopy } = require('./lib/content-quality');
const { isBlockedReviewRecord } = require('./lib/domain-filters');
const { classifyReviewUrl } = require('./lib/non-review-url-patterns');
const { normalizeReviewUrl } = require('./lib/ingest-collision');
const { isReviewTextFile } = require('./lib/review-text-sidecars');
const { countsPathFromArgv, writeAuditCounts } = require('./lib/audit-counts');

function isLive(data) {
  return !(data.contentTier === 'invalid' || data.isNonReview || data.excludeFromScoring
    || data.wrongShow || data.wrongProduction || data.isRoundupArticle);
}

// The writer's normaliser (tracking params dropped, real query kept), plus
// scheme and www folded so http/https and www twins are reported too.
function normUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  return normalizeReviewUrl(u).replace(/^https?:\/\/(?:www\.)?/i, '');
}

/**
 * Pure classifier for one show folder's parsed files. Exported for tests.
 * @param {Array<{file: string, data: object}>} files
 */
function auditShowFiles(showId, files) {
  const out = { promo: [], blocked: [], showHub: [], twins: [] };
  const byUrl = new Map();
  for (const { file, data } of files) {
    if (!data || typeof data !== 'object') continue;
    const id = `${showId}/${file}`;
    const live = isLive(data);
    const base = { id, outletId: data.outletId || null, source: data.source || null, contentTier: data.contentTier || null, live };
    const promo = detectPromoBookingCopy(data.fullText || '');
    if (promo.detected) out.promo.push({ ...base, matches: promo.matches });
    if (isBlockedReviewRecord(data)) out.blocked.push(base);
    const cls = typeof data.url === 'string' ? classifyReviewUrl(data.url) : null;
    if (cls && cls.reason === 'show-hub') out.showHub.push(base);
    const key = normUrl(data.url);
    if (key && live) {
      if (!byUrl.has(key)) byUrl.set(key, []);
      byUrl.get(key).push(id);
    }
  }
  for (const ids of byUrl.values()) if (ids.length > 1) out.twins.push(ids);
  return out;
}

function main(argv) {
  const json = argv.includes('--json');
  const showArg = (argv.find(a => a.startsWith('--show=')) || '').slice(7);
  const dir = resolveReviewTextsDir();
  if (!dir || !fs.existsSync(dir)) {
    console.error('review-texts not found; run with --review-texts via cloud-run-script.js');
    const missingCounts = countsPathFromArgv(argv);
    if (missingCounts) writeAuditCounts(missingCounts, 'audit-promo-booking-copy.js', { findings: null, reason: 'review-texts not found' });
    return 0;
  }
  const shows = showArg ? [showArg] : listShowDirs(dir, { silent: true });
  const total = { promo: [], blocked: [], showHub: [], twins: [] };
  let scanned = 0;
  let unreadable = 0;
  for (const showId of shows) {
    const sd = path.join(dir, showId);
    let names;
    try { names = fs.readdirSync(sd).filter(isReviewTextFile); } catch { continue; }
    const files = [];
    for (const file of names) {
      try { files.push({ file, data: JSON.parse(fs.readFileSync(path.join(sd, file), 'utf8')) }); } catch { unreadable++; }
    }
    scanned += files.length;
    const r = auditShowFiles(showId, files);
    for (const k of Object.keys(total)) total[k].push(...r[k]);
  }
  const live = rows => rows.filter(r => r.live).length;
  const countsPath = countsPathFromArgv(argv);
  if (countsPath) {
    writeAuditCounts(countsPath, 'audit-promo-booking-copy.js', {
      findings: live(total.promo) + live(total.showHub), scanned, unreadable,
      promo: total.promo.length, promoLive: live(total.promo), showHub: total.showHub.length, showHubLive: live(total.showHub),
      blocked: total.blocked.length, blockedLive: live(total.blocked), liveUrlTwins: total.twins.length,
    });
    console.log(`Scanned ${scanned} files; live promo ${live(total.promo)}, live show-hub ${live(total.showHub)}, live blocked-domain ${live(total.blocked)}, same-URL live twins ${total.twins.length}`);
    return 0;
  }
  if (json) {
    console.log(JSON.stringify({ scanned, unreadable, ...total }, null, 2));
    return 0;
  }
  console.log(`Scanned ${scanned} files in ${shows.length} show folders (${unreadable} unreadable JSON skipped)`);
  console.log(`\npromo booking copy: ${total.promo.length} (${live(total.promo)} live)`);
  for (const r of total.promo) console.log(`  ${r.live ? 'LIVE ' : 'excl '} ${r.id} [${r.source}/${r.contentTier}] ${r.matches.join(' | ')}`);
  console.log(`\nblocked-domain URL: ${total.blocked.length} (${live(total.blocked)} live)`);
  for (const r of total.blocked.filter(x => x.live)) console.log(`  LIVE  ${r.id} [${r.source}/${r.contentTier}]`);
  console.log(`\naggregator show-hub URL: ${total.showHub.length} (${live(total.showHub)} live)`);
  for (const r of total.showHub.filter(x => x.live)) console.log(`  LIVE  ${r.id} [${r.source}/${r.contentTier}]`);
  console.log(`\nsame-URL live twins: ${total.twins.length}`);
  for (const ids of total.twins) console.log(`  ${ids.join('  ==  ')}`);
  return 0;
}

module.exports = { auditShowFiles, isLive };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log('Usage: node scripts/audit-promo-booking-copy.js [--json] [--show=ID] [--counts=PATH]\nRead-only sweep: promo booking copy, blocked-domain URLs, aggregator show-hub URLs, same-URL live twins.');
    process.exit(0);
  }
  process.exit(main(argv));
}
