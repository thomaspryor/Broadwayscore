#!/usr/bin/env node
// BRO-7569: delete contentless `<outlet>--unknown.json` placeholders (no url, no text, no score, no excerpt)
// that sit beside a usable named review by the same outlet for the same show. Dry run by default.
// Usage: node scripts/cleanup-unknown-placeholders.js [--apply] [--recent-only]
const { hasHelpFlag } = require('./lib/cli-help');
const fs = require('fs');
const path = require('path');
const base = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const apply = process.argv.includes('--apply');
const recentOnly = process.argv.includes('--recent-only');
const { EXCERPT_FIELDS } = require('./lib/excerpt-fields');
const EXCERPT_KEYS = [...EXCERPT_FIELDS, 'excerpt', 'pullQuote'];
const SCORE_KEYS = ['originalScore', 'assignedScore', 'aggregatorStars', 'westEndTheatreScore', 'humanReviewScore', 'llmScore', 'dtliThumb', 'bwwThumb'];
const { foldDiacritics } = require('./lib/title-match');
const norm = (t) => foldDiacritics(String(t || '')).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
// every excerpt the placeholder carries is quoted inside this complete sibling's text
function excerptsQuotedIn(r, sib) {
  const t = norm(sib.fullText);
  return EXCERPT_KEYS.filter((k) => r[k] && String(r[k]).trim()).every((k) => {
    const probe = norm(r[k]).split(' ').slice(2, 10).join(' ');
    return probe.length > 20 && t.includes(probe);
  });
}
function isContentless(r, sibs = []) {
  if (r.criticName !== 'Unknown' || r.url || (r.fullText && r.fullText.trim())) return false;
  if (r.manualContentTier || r._locked || r.humanReviewScore != null) return false;
  if (EXCERPT_KEYS.some((k) => r[k] && String(r[k]).trim()) && !sibs.some((sb) => sb.contentTier === 'complete' && excerptsQuotedIn(r, sb))) return false;
  if (SCORE_KEYS.some((k) => r[k] !== undefined && r[k] !== null && r[k] !== '')) return false;
  return true;
}
function isCover(d) { return !!d.url && !d.wrongShow && !d.wrongProduction && !d.isRoundupArticle && !d.duplicateOf && !d.isNonReview; }
function main() {
  if (hasHelpFlag(process.argv)) { console.log('Usage: node scripts/cleanup-unknown-placeholders.js [--apply] [--recent-only]  (dry run unless --apply)'); process.exit(0); }
  const out = [];
  for (const s of fs.readdirSync(base)) {
    if (s.startsWith('_') || (recentOnly && !/-(2025|2026)(\b|-)/.test(s))) continue;
    let fl; try { fl = fs.readdirSync(path.join(base, s)); } catch { continue; }
    for (const f of fl) {
      const m = /^(.+)--unknown\.json$/.exec(f);
      if (!m) continue;
      let r; try { r = JSON.parse(fs.readFileSync(path.join(base, s, f), 'utf8')); } catch { continue; }
      const sibs = fl.filter((g) => g.startsWith(`${m[1]}--`) && g !== f && g.endsWith('.json')).map((g) => { try { return JSON.parse(fs.readFileSync(path.join(base, s, g), 'utf8')); } catch { return null; } }).filter(Boolean);
      if (!isContentless(r, sibs)) continue;
      if (sibs.some(isCover)) out.push(path.join(s, f));
    }
  }
  console.log(`${out.length} contentless Unknown placeholders beside a named review${recentOnly ? ' (2025-26 shows)' : ''}`);
  if (apply) { for (const p of out) fs.unlinkSync(path.join(base, p)); console.log(`deleted ${out.length}`); } else out.slice(0, 15).forEach((p) => console.log('  ' + p));
}
if (require.main === module) main();
module.exports = { isContentless, isCover, excerptsQuotedIn };
