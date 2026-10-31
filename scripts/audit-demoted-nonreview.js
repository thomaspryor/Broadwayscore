#!/usr/bin/env node
/**
 * audit-demoted-nonreview.js — read-only (BRO-5420).
 *
 * isNonReviewDemotedByFreshCV ignores an isNonReview flag when a newer
 * high-confidence content verification calls the article a review, unless the
 * flag is marked manual (manualNonReviewSet/By, manualReviewedBy, or an
 * isNonReviewReason starting "manual (not a review)"). That is right for stale
 * CV/classifier flags, but an approved fix plan's flag is a human decision:
 * brighton-beach-memoirs-2009 and america-who-hurt-you stayed live with
 * isNonReview true. review-field-edit now refuses an unmarked plan flag; this
 * lists the ones already on disk.
 *
 * Lists LIVE files (explainExclusion null) with isNonReview true that the
 * demotion is overriding, split into:
 *   plan     — an approved fix set the flag (approvedFixes); a hand check decides
 *              re-mark manual (real non-review) or clear (the CV is right);
 *   automatic — CV/classifier flags overridden by design (counted, not listed
 *              unless --all).
 * Prints the url, the flag reason, the CV verdict and the text head for the
 * hand check. Output is sealed by cloud-run-script.
 *
 * Usage: node scripts/audit-demoted-nonreview.js [--all] [--shard=i/n]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { explainExclusion, isNonReviewDemotedByFreshCV } = require('./lib/review-guards');
const { hasApprovedFlag } = require('./lib/approved-fix-flag');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const listAll = args.includes('--all');
const val = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const [shardIdx, shardCount] = (val('shard') || '0/1').split('/').map(Number);

function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const showById = Object.fromEntries((Array.isArray(raw) ? raw : (raw.shows || [])).map((s) => [s.id, s]));
  const textsDir = path.join(ROOT, 'data', 'review-texts');
  if (!fs.existsSync(textsDir)) { console.error('data/review-texts missing'); process.exit(1); }
  const shows = fs.readdirSync(textsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    .filter((_, i) => i % shardCount === shardIdx);
  const rows = [];
  let flagged = 0;
  let demoted = 0;
  for (const show of shows) {
    const dir = path.join(textsDir, show);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      if (r.isNonReview !== true) continue;
      flagged++;
      if (!isNonReviewDemotedByFreshCV(r)) continue;
      demoted++;
      let excl;
      try { excl = explainExclusion(r, showById[show] || null, path.join(dir, file)); } catch (e) { excl = `error: ${e.message}`; }
      if (excl) continue;
      const kind = hasApprovedFlag(r, 'isNonReview') ? 'plan' : 'automatic';
      const cv = r.contentVerification || {};
      rows.push({ kind, show, file, critic: r.criticName || null, url: r.url || null,
        reason: String(r.isNonReviewReason || '').slice(0, 160),
        cv: `${cv.articleType || '-'}/${cv.articleTypeConfidence || cv.confidence || '-'} ${String(cv.verifiedAt || '').slice(0, 10)}`,
        head: String(r.fullText || '').replace(/\s+/g, ' ').slice(0, 200) });
    }
  }
  const plan = rows.filter((x) => x.kind === 'plan');
  console.log(`isNonReview true: ${flagged}; demoted by a fresh CV: ${demoted}; live after demotion: ${rows.length} (plan-set ${plan.length}, automatic ${rows.length - plan.length})${shardCount > 1 ? ` (shard ${shardIdx}/${shardCount})` : ''}`);
  console.log('kind | show | file | critic | cv | reason | url | text head');
  for (const x of (listAll ? rows : plan)) {
    console.log([x.kind, x.show, x.file, x.critic, x.cv, JSON.stringify(x.reason), x.url, JSON.stringify(x.head)].join(' | '));
  }
}

if (require.main === module) main();
