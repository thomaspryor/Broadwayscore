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
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const val = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const outlets = (val('outlet') || '').split(',').filter(Boolean);
const listN = Number(val('list') || 300);
const asJson = args.includes('--json');
if (!outlets.length) { console.error('usage: audit-outlet-text-status.js --outlet=wsj[,x] [--list=N] [--json]'); process.exit(2); }

const EXCLUDING_FLAGS = ['wrongProduction', 'wrongShow', 'wrongAttribution', 'duplicateOf', 'isNonReview', 'isSyndicatedDuplicate', 'isRoundupArticle'];

function urlShape(url) {
  if (!url) return 'no-url';
  if (!/^https?:\/\//i.test(url)) return 'not-a-url';
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
      if (!outlets.includes(r.outletId)) continue;
      const chars = String(r.fullText || '').length;
      const cvRejected = r.contentVerification && r.contentVerification.isValid === false;
      const excludedBy = EXCLUDING_FLAGS.find((k) => r[k]) || null;
      const full = r.contentTier === 'complete' && !cvRejected && chars >= 500;
      const fail = failById.get(`${show}/${file}`);
      rows.push({
        show, file, critic: r.criticName || null, pub: r.publishDate || null, url: r.url || null,
        tier: r.contentTier || null, chars, cvRejected: !!cvRejected, excludedBy,
        status: excludedBy ? 'excluded-other-reason' : full ? 'full-text' : 'no-full-text',
        lastFailure: fail ? fail.failureReason : (r.incompleteReason || null),
        failureCount: fail ? fail.failureCount : null,
        urlShape: urlShape(r.url), decade: decade(r.publishDate),
      });
    }
  }

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

if (require.main === module) main();
