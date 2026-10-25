#!/usr/bin/env node
/**
 * Read-only scan of data/review-texts for the review-text-gap cards
 * (BRO-4426 textless needsRefetch, BRO-4564 truncated-fetch exclusions,
 * BRO-4301 producers). Prints metadata only, never article text.
 *   node scripts/audit-text-gap-cards.js --card=4426|4564|4301 [--show=ID]
 */
const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { isCvVerdictFromTruncatedFetch } = require('./lib/content-verifier');
const { isTextlessNeedsRefetch } = require('./lib/collection-priority');

const arg = (k) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const card = arg('card');
const only = arg('show');
const root = path.join(__dirname, '..', 'data', 'review-texts');
if (!fs.existsSync(root)) { console.error('data/review-texts missing'); process.exit(2); }

const liveKey = new Set();
try {
  const r = require('../data/reviews.json');
  for (const v of (r.reviews || r)) liveKey.add(`${v.showId}|${v.outletId}|${(v.criticName || '').toLowerCase()}`);
} catch {}

const showsById = {};
try { const sj = require('../data/shows.json'); for (const v of (sj.shows || sj)) showsById[v.id] = v; } catch {}

let failed = {};
try {
  for (const f of JSON.parse(fs.readFileSync(path.join(root, 'failed-fetches.json'), 'utf8'))) failed[f.reviewId || `${f.showId}/${f.file}`] = f;
} catch {}

function restoreTargets() {
  const dir = path.join(__dirname, '..', 'data', 'pending-fixes');
  const out = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!/^bro-4564-[a-d]\.json$/.test(f)) continue;
    for (const a of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).plan.actions) out.add(a.file.replace(/\.json$/, '') + '.json');
  }
  return out;
}

const rows = [];
for (const showId of listShowDirs(root, { silent: true })) {
  const dir = path.join(root, showId);
  if (only && showId !== only) continue;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
    const id = `${showId}/${file}`;
    if (card === '4426' && isTextlessNeedsRefetch(d) && !d.fullText) {
      const shipped = liveKey.has(`${showId}|${d.outletId}|${(d.criticName || '').toLowerCase()}`);
      const f = failed[id];
      rows.push({ id, shipped, urlCorrected: !!d.urlCorrectedFrom, flags: ['wrongShow', 'wrongProduction', 'duplicateOf', 'isNonReview', 'fabricatedEntry'].filter(k => d[k]).join(','), incompleteReason: d.incompleteReason || '', fails: f ? `${f.failureCount}:${f.failureReason}` : '', tier: d.contentTier || '', url: d.url });
    }
    if (card === '4564') {
      const cv = d.contentVerification;
      const hit = cv && isCvVerdictFromTruncatedFetch(cv, d.fullText || d.wrongFullText || '', d.url);
      if (hit && (d.wrongShow || d.isNonReview || d.rejectionReason === 'not_a_review')) {
        rows.push({ id, flags: ['wrongShow', 'isNonReview'].filter(k => d[k]).join(','), rej: d.rejectionReason || '', cleared: !!(d.humanReviewedWrongProduction === false || d.manualClear), publishDate: d.publishDate || '', textLen: (d.fullText || d.wrongFullText || '').length, excerpt: !!(d.aggregatorExcerpt || d.excerpt), url: d.url, cvType: cv.articleType, cvSaid: String(cv.reasoning || '').slice(0, 160) });
      }
    }
    if (card === '4564-detail') {
      const cv = d.contentVerification;
      const hit = cv && isCvVerdictFromTruncatedFetch(cv, d.fullText || d.wrongFullText || '', d.url);
      if (hit && (d.wrongShow || d.isNonReview || d.rejectionReason === 'not_a_review') && !/brittani-samuel/.test(file)) {
        const t = (d.fullText || d.wrongFullText || '').replace(/\s+/g, ' ');
        const sh = showsById[showId] || {};
        rows.push({ id, run: `${sh.previewsStartDate || ''}..${sh.openingDate || ''}..${sh.closingDate || ''}`, title: sh.title, publishDate: d.publishDate || '', url: d.url, head: t.slice(0, 260), tail: t.slice(-120), cvSaid: String(cv.reasoning || '').slice(0, 200), agg: String(d.aggregatorExcerpt || d.excerpt || '').slice(0, 120) });
      }
    }
    if (card === 'file' && arg('file') === id) {
      const scalars = {};
      for (const [k, v] of Object.entries(d)) {
        if (typeof v === 'string' && !/text/i.test(k)) scalars[k] = v.slice(0, 160);
        else if (typeof v === 'boolean' || typeof v === 'number' || v === null) scalars[k] = v;
      }
      const t = (d.fullText || d.wrongFullText || '').replace(/\s+/g, ' ');
      const dates = (t.match(/\b(?:\d{1,2}\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(?:\d{1,2},?\s+)?20\d\d\b/g) || []).slice(0, 8);
      rows.push({ id, scalars, head: t.slice(0, 200), dates });
    }
    if (card === '4564-live') {
      const planFiles = restoreTargets();
      if (planFiles.has(id)) {
        const live = liveKey.has(`${showId}|${d.outletId}|${(d.criticName || '').toLowerCase()}`);
        const keep = Object.entries(d).filter(([k, v]) => /^(source|contentTier|rejectedAt|rejectionReason|wrongShow|wrongProduction|isNonReview|fabricatedEntry|crossOutletDuplicate|duplicateOf|roundupArticle|unverifiable\w*|textStatus|textQuality)$/.test(k) && v !== null && v !== false && v !== undefined).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`);
        rows.push({ id, live, why: keep.join(', ') });
      }
    }
    if (card === '4301' && only) {
      rows.push({ id, criticName: d.criticName, publishDate: d.publishDate, textLen: (d.fullText || '').length, url: d.url, wrongProduction: !!d.wrongProduction, flags: Object.keys(d).filter(k => /wrong|priorRun|dateSource|publishDateSource/i.test(k)).join(',') });
    }
  }
}
console.log(JSON.stringify({ card, count: rows.length }));
for (const r of rows) console.log(JSON.stringify(r));
// BRO-4426 acceptance: textless reviews a fetch can still fix. A dead url (3+
// recorded failures) or a flagged file needs URL rediscovery, not the drain.
if (card === '4426' && arg('max-eligible') !== undefined && arg('max-eligible') !== '') {
  const fails = (r) => (r.fails ? Number(r.fails.split(':')[0]) : 0);
  const eligible = rows.filter(r => r.shipped && !r.flags && fails(r) < 3).length;
  const max = Number(arg('max-eligible'));
  console.log(JSON.stringify({ shippedEligibleTextless: eligible, max }));
  process.exit(eligible <= max ? 0 : 1);
}
