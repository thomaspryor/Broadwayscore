'use strict';

/**
 * key-duplicate-plan.js (BRO-5274)
 *
 * Decides what to do with a group of review files that share one
 * (showDir | outlet | criticName) key. reviews.json is already protected from
 * the duplicate (final-key-dedup.js collapses the key at rebuild), so the cost
 * is corpus hygiene and a standing red drift audit, not a double count. The
 * 53 groups on 2026-10-13 were two shapes:
 *
 *   same-review   two files hold one article (same URL once query/slash/www are
 *                 stripped, or the same opening text): keep one, mark the other
 *                 duplicateOf. Typical cause: `outlet--unknown.json` left beside
 *                 the later named file, or two aggregator bylines on one URL.
 *   byline-clash  two DIFFERENT articles that both carry one criticName: the
 *                 file whose own name appears in its text and whose criticName
 *                 does not is mis-stamped; fix the criticName.
 *
 * Anything else is returned as `ambiguous` for a human; nothing is guessed.
 * Pure functions (CLAUDE.md §15); scripts/plan-key-duplicate-fixes.js does the
 * corpus scan and emits review-field-edit actions.
 */

function normUrl(u) {
  if (!u || typeof u !== 'string') return null;
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, '').toLowerCase()}${x.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch { return null; }
}

const { foldDiacritics } = require('./title-match');

function normText(t) {
  return foldDiacritics(String(t || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 300);
}

function isUnknownFile(file) {
  return /--unknown\.json$/.test(file);
}

/**
 * Which of two files of one review to keep. Evidence order: a human score, a
 * critic's own rating, a real byline over `--unknown`, a complete longer text,
 * then the filename (stable).
 * @param {{file:string, hrs?:*, orig?:*, textLen?:number, tier?:string}} a
 * @param {{file:string, hrs?:*, orig?:*, textLen?:number, tier?:string}} b
 * @returns {{keep: object, drop: object}}
 */
function chooseCanonical(a, b) {
  const rank = (f) => [
    f.hrs != null ? 1 : 0,
    f.orig != null ? 1 : 0,
    isUnknownFile(f.file) ? 0 : 1,
    f.tier === 'complete' ? 1 : 0,
    f.textLen || 0,
  ];
  const ra = rank(a); const rb = rank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return ra[i] > rb[i] ? { keep: a, drop: b } : { keep: b, drop: a };
  }
  return a.file <= b.file ? { keep: a, drop: b } : { keep: b, drop: a };
}

function sameReview(a, b) {
  const ua = normUrl(a.url); const ub = normUrl(b.url);
  if (ua && ub && ua === ub) return true;
  const ta = normText(a.head); const tb = normText(b.head);
  return ta.length >= 120 && ta === tb;
}

const titleCase = (slug) => slug.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const fileSlug = (file) => (file.replace(/\.json$/, '').split('--')[1] || '');

/**
 * @param {Array<{file:string, url?:string, head?:string, critic?:string, hrs?:*, orig?:*, textLen?:number, tier?:string, bylineFile?:boolean|null, bylineField?:boolean|null}>} files one key group, file = bare filename
 * @returns {{actions: Array<{kind:'duplicateOf'|'criticName', file:string, to?:string, from?:string, newName?:string, why:string}>, ambiguous: string[]}}
 */
function planKeyGroup(files) {
  const actions = [];
  const ambiguous = [];
  if (files.length !== 2) {
    return { actions, ambiguous: [`group of ${files.length}: ${files.map((f) => f.file).join(', ')}`] };
  }
  const [a, b] = files;
  if (sameReview(a, b)) {
    const { keep, drop } = chooseCanonical(a, b);
    actions.push({ kind: 'duplicateOf', file: drop.file, to: keep.file, why: 'same article (url or opening text), keeping the file with more evidence' });
    return { actions, ambiguous };
  }
  // Different articles under one criticName: repair the mis-stamped name.
  const fixable = files.filter((f) => f.bylineFile === true && f.bylineField === false && fileSlug(f.file) && fileSlug(f.file) !== 'unknown');
  if (fixable.length === 1) {
    const f = fixable[0];
    actions.push({ kind: 'criticName', file: f.file, from: f.critic, newName: titleCase(fileSlug(f.file)), why: 'text names the filename critic, not the stamped criticName' });
    return { actions, ambiguous };
  }
  ambiguous.push(`different articles, byline evidence inconclusive: ${a.file}, ${b.file}`);
  return { actions, ambiguous };
}

module.exports = { planKeyGroup, chooseCanonical, sameReview, normUrl };
