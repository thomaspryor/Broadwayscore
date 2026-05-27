#!/usr/bin/env node
/**
 * Audit existing review-texts/{showId}/ for files that the current slug
 * matcher would re-route to a different show.
 *
 * Filters to TRUE misroutes — cases where the FROM show's distinctive
 * tokens are NOT all in the article slug, but the TO show's are. These
 * are the routings that the pre-2026-05-27 longest-substring matcher got
 * wrong (e.g. Bedlam's Othello article routed to closed `othello-2025`
 * because "othello" beat "bedlams-othello" on length).
 *
 * Output: writes /tmp/true-misroutes.json with full details + prints a
 * grouped summary by (from, to) showId pair.
 *
 * Use: node scripts/audit-slug-match-routing.js
 *      node scripts/audit-slug-match-routing.js --apply  (NOT YET IMPLEMENTED)
 *
 * The --apply path would move files, but is intentionally not built —
 * the audit produces false positives for shows with venue-suffixed IDs
 * (e.g. `cabaret-at-the-kit-kat-club-west-end-2021` for a 2021 "Cabaret"
 * article) where the slug has no venue mention but the article truly
 * refers to that specific production. Manual review of the audit is
 * required before moving files.
 */

const fs = require('fs');
const path = require('path');
const { matchSlugToShow, matchBwwRoundupSlugToShow, loadShows } = require('./lib/show-matching');

const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR
  || path.join(process.env.HOME || '/tmp', 'broadway-review-texts');

if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
  console.error(`review-texts dir not found: ${REVIEW_TEXTS_DIR}`);
  console.error('Set REVIEW_TEXTS_DIR env var if running outside the local clone.');
  process.exit(1);
}

const SLUG_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'in', 'on', 'at', 'for', 'to', 'by',
  'broadway', 'off-broadway', 'west-end', 'musical', 'play', 'show',
  'revival', 'tour', 'starring', 'opens', 'review', 'reviews', 'critics',
]);

function distinctiveTokens(show) {
  const slug = (show.slug || show.id || '').toLowerCase();
  if (!slug) return [];
  const stripped = slug
    .replace(/-(19|20)\d{2}$/, '')
    .replace(/-off-broadway(-(19|20)\d{2})?$/, '')
    .replace(/-west-end(-(19|20)\d{2})?$/, '')
    .replace(/-bway$/, '')
    .replace(/-broadway(-(19|20)\d{2})?$/, '');
  return [...new Set(stripped.split('-').filter(t => t.length >= 3 && !SLUG_STOPWORDS.has(t)))];
}

function tokenAppears(tok, slug) {
  let idx = -1;
  while ((idx = slug.indexOf(tok, idx + 1)) !== -1) {
    if ((idx === 0 || slug[idx - 1] === '-')
      && (idx + tok.length === slug.length || slug[idx + tok.length] === '-')) return true;
  }
  return false;
}

// Mirror the matcher's head/tail strip so we audit against the same input
// the matcher would see.
const PV_HEAD = [
  /^reviews-what-(do-the|did)-critics-think-of-/,
  /^reviews-(did|do)-(the-)?critics-(feel-at-home-on|find|think)-/,
  /^reviews-are-out-for-/, /^read-the-reviews-for-/, /^read-reviews-for-/,
  /^what-(are|do|did)-(the-)?(reviews|critics)-(think-of-|for-)?/,
  /^did-the-olivier-winning-/,
  /^did-(reviewers|critics)-(find-magic-in-|think-of-|find-)?/, /^how-did-/,
];
const PV_TAIL = [
  /-in-londons-west-end$/, /-on-broadway$/, /-off-broadway$/,
  /-at-(brooklyn-academy-of-music|met-opera|studio-seaview|linda-gross|atlantic-theater|signature(-theatre)?|new-york-theatre-workshop|classic-stage-company|second-stage|playwrights-horizons|the-public-theater|theatre-row|audible|bam)$/,
];
const BWW_HEAD = [/^review-roundup-/];
const BWW_TAIL = [
  /-opens-(off-)?broadway-?\d{0,8}$/, /-opens-on-broadway-?\d{0,8}$/,
  /-on-broadway-?\d{0,8}$/, /-off-broadway-?\d{0,8}$/,
  /-opens-at-.*$/, /-broadway-?\d{0,8}$/, /-\d{8}$/,
];

function cleanSlug(rawSlug, source) {
  let s = String(rawSlug).toLowerCase()
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/^\/?article\//, '');
  const HEAD = source === 'bww' ? BWW_HEAD : PV_HEAD;
  const TAIL = source === 'bww' ? BWW_TAIL : PV_TAIL;
  for (const p of HEAD) s = s.replace(p, '');
  for (const p of TAIL) s = s.replace(p, '');
  return s;
}

function main() {
  const shows = loadShows();
  const showById = new Map(shows.map(s => [s.id, s]));

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(d => !d.startsWith('.') && !d.startsWith('_'))
    .filter(d => {
      try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory(); }
      catch { return false; }
    });

  console.log(`Scanning ${showDirs.length} show directories in ${REVIEW_TEXTS_DIR}...`);

  const trueMisroutes = [];
  let scanned = 0;

  for (const showId of showDirs) {
    const files = fs.readdirSync(path.join(REVIEW_TEXTS_DIR, showId)).filter(f => f.endsWith('.json'));
    for (const f of files) {
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(REVIEW_TEXTS_DIR, showId, f), 'utf8')); }
      catch { continue; }
      scanned++;

      // Identify aggregator-discovery URLs we can re-evaluate
      let slug = null, source = null, matcher = null;
      if (r.playbillVerdictUrl && r.playbillVerdictUrl.includes('playbill.com/article/')) {
        slug = (r.playbillVerdictUrl.split('/article/')[1] || '').replace(/[?#].*$/, '');
        source = 'pv';
        matcher = matchSlugToShow;
      } else if (r.bwwRoundupUrl && r.bwwRoundupUrl.includes('Review-Roundup')) {
        slug = r.bwwRoundupUrl.split('/article/')[1] || '';
        source = 'bww';
        matcher = matchBwwRoundupSlugToShow;
      }
      if (!slug || !matcher) continue;

      const m = matcher(slug, shows);
      if (!m || m.show.id === showId) continue;

      // Filter to TRUE misroutes — FROM's distinctive tokens are NOT all in
      // the cleaned slug, but TO's are. Skip false-positive shuffles
      // (e.g. recency-tiebreak moves where both shows fully match).
      const fromShow = showById.get(showId);
      const toShow = m.show;
      if (!fromShow || !toShow) continue;

      const cleanedSlug = cleanSlug(slug, source);
      const fromTokens = distinctiveTokens(fromShow);
      const toTokens = distinctiveTokens(toShow);
      const fromMatched = fromTokens.filter(t => tokenAppears(t, cleanedSlug)).length;
      const toMatched = toTokens.filter(t => tokenAppears(t, cleanedSlug)).length;

      const isTrueMisroute = (toMatched > fromMatched)
        || (fromMatched < fromTokens.length && toMatched === toTokens.length);
      if (!isTrueMisroute) continue;

      trueMisroutes.push({
        from: showId, to: m.show.id, file: f, slug, source,
        url: r.playbillVerdictUrl || r.bwwRoundupUrl,
        fromTokens: fromTokens.join('|'),
        toTokens: toTokens.join('|'),
      });
    }
  }

  console.log(`Scanned files: ${scanned}`);
  console.log(`TRUE misroutes: ${trueMisroutes.length}`);
  console.log();

  const byKey = {};
  for (const m of trueMisroutes) {
    const k = `${m.from} → ${m.to}`;
    byKey[k] = (byKey[k] || 0) + 1;
  }
  const sorted = Object.entries(byKey).sort((a, b) => b[1] - a[1]).slice(0, 50);
  for (const [k, n] of sorted) console.log(' ', String(n).padStart(3), '|', k);

  const outPath = '/tmp/true-misroutes.json';
  fs.writeFileSync(outPath, JSON.stringify(trueMisroutes, null, 2));
  console.log();
  console.log(`Full audit: ${outPath}`);
}

if (require.main === module) main();
