#!/usr/bin/env node
/**
 * BRO-4444: list review-text files still in the BRO-4430 drop classes, so a
 * data/pending-fixes plan (model: bro-4430.json) can repair them. Read-only.
 *
 *   aggregator-url        file holds text but its url is an aggregator/round-up page
 *   other-critic-url      a sibling holds the same url for a DIFFERENT named critic
 *   dateless-hold         wrongProduction hold from the dateless-revival guard
 *   flagged-non-review    flagged file whose own url is not a review page
 *
 * Usage: node scripts/audit-coverage-slot-drops.js [--dir=data/review-texts] [--json]
 * Exit 0 always; candidates are printed. Needs the full review-texts checkout.
 */
const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const guards = require('./lib/review-slot-guards');

function hasText(d) {
  return typeof d.fullText === 'string' && d.fullText.trim().length > 0;
}

const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

// dupKeys: Set of sameUrlKey values held by 2+ files in the show folder. Lets the
// per-file guard (which re-reads the whole folder) run only where a collision exists.
function classifyFile(d, { showDir, filename, dupKeys, siblingReviewUrls = [] }) {
  const classes = [];
  if (!d || typeof d !== 'object') return classes;
  if (d._locked === true || d.urlManualOverride === true || d.duplicateOf) return classes;
  if (!isHttp(d.url)) return classes;
  const flagged = d.wrongProduction === true || d.wrongShow === true || d.isNonReview === true;
  const { sameUrlKey } = require('./lib/review-url-collision');
  // Flagged files are excluded here: a flag on an aggregator url is the correct state.
  if (!flagged && hasText(d) && guards.isAggregatorPageUrl(d.url)) classes.push('aggregator-url');
  if ((!dupKeys || dupKeys.has(sameUrlKey(d.url)))
    && guards.urlOwnedByOtherCritic({ showDir, url: d.url, selfFilename: filename, selfCriticName: d.criticName })) {
    classes.push('other-critic-url');
  }
  if (guards.isDatelessRevivalHold(d)) classes.push('dateless-hold');
  // A flagged slot only needs repair when a real review url from the same outlet exists to take
  // it over (isStaleNonReviewSlot): a correctly flagged junk page with no replacement is fine.
  if (flagged && !guards.isDatelessRevivalHold(d)
    && siblingReviewUrls.some((u) => guards.isStaleNonReviewSlot(d, u))) classes.push('flagged-non-review');
  return classes;
}

const { listShowDirs } = require('./lib/list-show-dirs');

function auditCorpus(dir) {
  const out = [];
  const { sameUrlKey } = require('./lib/review-url-collision');
  let shows = [];
  try { shows = listShowDirs(dir, { silent: true, skipHolding: true }); } catch { return out; }
  for (const show of shows.sort()) {
    const showDir = path.join(dir, show);
    const loaded = [];
    for (const filename of fs.readdirSync(showDir).filter((f) => isReviewTextFile(f)).sort()) {
      try { loaded.push({ filename, d: JSON.parse(fs.readFileSync(path.join(showDir, filename), 'utf8')) }); } catch { /* unreadable */ }
    }
    const counts = new Map();
    for (const { d } of loaded) {
      const k = d && isHttp(d.url) ? sameUrlKey(d.url) : null;
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
    }
    const dupKeys = new Set([...counts].filter(([, n]) => n > 1).map(([k]) => k));
    for (const { filename, d } of loaded) {
      const outlet = filename.split('--')[0];
      const siblingReviewUrls = loaded
        .filter((o) => o.filename !== filename && o.filename.split('--')[0] === outlet && o.d && isHttp(o.d.url)
          && !o.d.wrongProduction && !o.d.wrongShow && !o.d.isNonReview && !o.d.duplicateOf)
        .map((o) => o.d.url);
      const classes = classifyFile(d, { showDir, filename, dupKeys, siblingReviewUrls });
      if (classes.length) out.push({ show, filename, url: d.url || null, classes });
    }
  }
  return out;
}

if (require.main === module) {
  const dirArg = process.argv.find((a) => a.startsWith('--dir='));
  const dir = dirArg ? dirArg.slice(6) : path.join(__dirname, '..', 'data', 'review-texts');
  if (!fs.existsSync(dir)) { console.error(`review-texts dir not found: ${dir} (needs the full checkout)`); process.exit(2); }
  const candidates = auditCorpus(dir);
  if (process.argv.includes('--json')) console.log(JSON.stringify(candidates, null, 2));
  else {
    for (const c of candidates) console.log(`${c.classes.join(',')}\t${c.show}/${c.filename}\t${c.url}`);
    console.log(`${candidates.length} candidate file(s) in ${dir}`);
  }
}

module.exports = { auditCorpus, classifyFile };
