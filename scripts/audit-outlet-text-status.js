#!/usr/bin/env node
/**
 * audit-outlet-text-status.js — read-only (BRO-5243).
 *
 * One outlet's text coverage across every review file: how many rows we hold,
 * how many carry a full verified text, how many do not, and why. Groups the
 * rows without text by the collector's last failure (data/review-texts/
 * failed-fetches.json), by url shape (no url, AP wire page, online.wsj.com
 * column, wsj.com/articles slug, other) and by decade, and lists the
 * remaining rows. Ids, critics, dates and urls only, never review text.
 *
 * A row counts as "full text" when contentTier is complete and the content
 * verifier, if it ran, did not reject it. Rows the rebuild excludes for
 * another reason (wrongProduction, duplicateOf, ...) are reported apart.
 *
 * Usage: node scripts/audit-outlet-text-status.js --outlet=wsj [--list=N] [--json]
 *
 * --zero-char-hosts[=DAYS] (BRO-6486) scans every outlet instead: for files
 * first seen in the last DAYS (default 30) that no flag excludes, it lists each
 * url host where at least 3 such files exist and every one holds 0 chars of
 * text and a strict majority have no logged failure (null, none or
 * not_attempted). Each flagged host includes a silent count and lastFailure
 * breakdown. That is the "outlet silently unreadable" shape Exeunt NYC showed on
 * 2026-10-28 (there the files pointed at WordPress photo-attachment pages,
 * now reported as urlShape wp-attachment). Exit 1 when any host is flagged.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { wordpressAttachmentParentUrl } = require('./lib/non-review-url-patterns');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const val = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const outlets = (val('outlet') || '').split(',').filter(Boolean);
const zeroArg = args.find((x) => x === '--zero-char-hosts' || x.startsWith('--zero-char-hosts='));
const zeroDays = zeroArg ? Number(zeroArg.split('=')[1] || 30) : null;
const ZERO_MIN_FILES = 3;
const listN = Number(val('list') || 300);
const asJson = args.includes('--json');

const EXCLUDING_FLAGS = ['wrongProduction', 'wrongShow', 'wrongAttribution', 'duplicateOf', 'isNonReview', 'isSyndicatedDuplicate', 'isRoundupArticle'];

function urlShape(url) {
  if (!url) return 'no-url';
  if (!/^https?:\/\//i.test(url)) return 'not-a-url';
  if (wordpressAttachmentParentUrl(url)) return 'wp-attachment';
  if (/online\.wsj\.com\/article\/AP/i.test(url)) return 'ap-wire-page';
  if (/online\.wsj\.com\//i.test(url)) return 'online.wsj.com';
  if (/wsj\.com\/articles\//i.test(url)) return 'wsj.com/articles';
  if (/wsj\.com/i.test(url)) return 'wsj.com-other';
  return 'other-domain';
}

function decade(d) {
  const m = /\b(19|20)(\d)\d\b/.exec(String(d || ''));
  return m ? `${m[1]}${m[2]}0s` : 'no-date';
}

function main() {
  if (zeroDays != null && !(zeroDays > 0)) { console.error('--zero-char-hosts=DAYS needs a positive number'); process.exit(2); }
  if (!outlets.length && zeroDays == null) { console.error('usage: audit-outlet-text-status.js --outlet=wsj[,x] [--list=N] [--json] | --zero-char-hosts[=DAYS]'); process.exit(2); }
  const textsDir = path.join(ROOT, 'data', 'review-texts');
  if (!fs.existsSync(textsDir)) { console.error('data/review-texts missing'); process.exit(1); }
  let failed = [];
  try { failed = JSON.parse(fs.readFileSync(path.join(textsDir, 'failed-fetches.json'), 'utf8')); } catch { /* none */ }
  const failById = new Map(failed.map((f) => [f.reviewId, f]));

  const rows = [];
  for (const show of fs.readdirSync(textsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const dir = path.join(textsDir, show);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      if (zeroDays == null && !outlets.includes(r.outletId)) continue;
      const chars = String(r.fullText || '').length;
      const cvRejected = r.contentVerification && r.contentVerification.isValid === false;
      const excludedBy = EXCLUDING_FLAGS.find((k) => r[k]) || null;
      const full = r.contentTier === 'complete' && !cvRejected && chars >= 500;
      const fail = failById.get(`${show}/${file}`);
      rows.push({
        show, file, outletId: r.outletId || null, critic: r.criticName || null, pub: r.publishDate || null, url: r.url || null,
        tier: r.contentTier || null, chars, cvRejected: !!cvRejected, excludedBy,
        status: excludedBy ? 'excluded-other-reason' : full ? 'full-text' : 'no-full-text',
        lastFailure: fail ? fail.failureReason : (r.incompleteReason || null),
        failureCount: fail ? fail.failureCount : null,
        urlShape: urlShape(r.url), decade: decade(r.publishDate), firstSeenAt: r.firstSeenAt || null,
      });
    }
  }

  if (zeroDays != null) return reportZeroCharHosts(rows, zeroDays);

  const count = (list, key) => list.reduce((m, r) => { const k = r[key] == null ? 'none' : String(r[key]); m[k] = (m[k] || 0) + 1; return m; }, {});
  const missing = rows.filter((r) => r.status === 'no-full-text');
  const summary = {
    outlets, total: rows.length,
    byStatus: count(rows, 'status'),
    missingByLastFailure: count(missing, 'lastFailure'),
    missingByUrlShape: count(missing, 'urlShape'),
    missingByTier: count(missing, 'tier'),
    missingByDecade: count(missing, 'decade'),
    missingByCritic: count(missing, 'critic'),
    missingCvRejected: missing.filter((r) => r.cvRejected).length,
  };
  if (asJson) { console.log(JSON.stringify({ summary, missing: missing.slice(0, listN) }, null, 2)); return; }
  for (const [k, v] of Object.entries(summary)) console.log(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  console.log('\nshow | file | critic | pub | tier | chars | cvRejected | lastFailure | urlShape | url');
  for (const r of missing.slice(0, listN)) {
    console.log([r.show, r.file, r.critic, r.pub, r.tier, r.chars, r.cvRejected, r.lastFailure, r.urlShape, r.url].join(' | '));
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

/** Hosts whose recent files are all empty and mostly silent (pure, exported for the test). */
function zeroCharHosts(rows, days, nowMs = Date.now()) {
  const since = nowMs - days * 86400000;
  const byHost = new Map();
  for (const r of rows) {
    if (r.excludedBy || !r.firstSeenAt || !(Date.parse(r.firstSeenAt) >= since)) continue;
    const h = hostOf(r.url);
    if (!h) continue;
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(r);
  }
  const flagged = [];
  for (const [host, list] of byHost) {
    if (list.length >= ZERO_MIN_FILES && list.every((r) => r.chars === 0)) {
      const byLastFailure = {};
      let silent = 0;
      for (const r of list) {
        const reason = r.lastFailure == null ? 'none' : String(r.lastFailure);
        byLastFailure[reason] = (byLastFailure[reason] || 0) + 1;
        if (reason === 'none' || reason === 'not_attempted') silent++;
      }
      if (silent <= list.length / 2) continue;
      flagged.push({ host, files: list.length, silent, byLastFailure, outlets: [...new Set(list.map((r) => r.outletId))], urlShapes: [...new Set(list.map((r) => r.urlShape))], examples: list.slice(0, 3).map((r) => `${r.show}/${r.file}`) });
    }
  }
  return flagged.sort((a, b) => b.files - a.files);
}

function reportZeroCharHosts(rows, days) {
  const flagged = zeroCharHosts(rows, days);
  const attachments = rows.filter((r) => r.urlShape === 'wp-attachment' && !r.excludedBy).length;
  if (asJson) console.log(JSON.stringify({ days, flagged, wpAttachmentFiles: attachments }, null, 2));
  else {
    console.log(`hosts whose files first seen in the last ${days} days all hold 0 chars and mostly have no logged failure (min ${ZERO_MIN_FILES} files): ${flagged.length}`);
    for (const f of flagged) console.log(`  ${f.host} | ${f.files} files | silent ${f.silent} | lastFailure ${JSON.stringify(f.byLastFailure)} | outlets ${f.outlets.join(',')} | urlShapes ${f.urlShapes.join(',')} | e.g. ${f.examples.join(' ')}`);
    console.log(`wp-attachment url files not excluded, all outlets: ${attachments}`);
  }
  if (flagged.length) process.exitCode = 1;
}

module.exports = { zeroCharHosts, urlShape };

if (require.main === module) main();
