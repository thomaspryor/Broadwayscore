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
const fs = require('fs');
const path = require('path');
const guards = require('./lib/review-slot-guards');

function hasText(d) {
  return typeof d.fullText === 'string' && d.fullText.trim().length > 0;
}

function classifyFile(d, { showDir, filename }) {
  const classes = [];
  if (!d || typeof d !== 'object') return classes;
  if (d._locked === true || d.urlManualOverride === true) return classes;
  if (d.url && hasText(d) && guards.isAggregatorPageUrl(d.url)) classes.push('aggregator-url');
  if (d.url && !d.duplicateOf
    && guards.urlOwnedByOtherCritic({ showDir, url: d.url, selfFilename: filename, selfCriticName: d.criticName })) {
    classes.push('other-critic-url');
  }
  if (guards.isDatelessRevivalHold(d)) classes.push('dateless-hold');
  const flagged = d.wrongProduction === true || d.wrongShow === true || d.isNonReview === true;
  if (flagged && !d.duplicateOf && d.url && !guards.isDatelessRevivalHold(d)) {
    const { classifyReviewUrl } = require('./lib/non-review-url-patterns');
    if (classifyReviewUrl(d.url).ok === false) classes.push('flagged-non-review');
  }
  return classes;
}

function auditCorpus(dir) {
  const out = [];
  let shows = [];
  try { shows = fs.readdirSync(dir).filter((s) => fs.statSync(path.join(dir, s)).isDirectory()); } catch { return out; }
  for (const show of shows.sort()) {
    const showDir = path.join(dir, show);
    for (const filename of fs.readdirSync(showDir).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json').sort()) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(showDir, filename), 'utf8')); } catch { continue; }
      const classes = classifyFile(d, { showDir, filename });
      if (classes.length) out.push({ show, filename, url: d.url || null, classes });
    }
  }
  return out;
}

if (require.main === module) {
  const dirArg = process.argv.find((a) => a.startsWith('--dir='));
  const dir = dirArg ? dirArg.slice(6) : path.join(__dirname, '..', 'data', 'review-texts');
  const candidates = auditCorpus(dir);
  if (process.argv.includes('--json')) console.log(JSON.stringify(candidates, null, 2));
  else {
    for (const c of candidates) console.log(`${c.classes.join(',')}\t${c.show}/${c.filename}\t${c.url}`);
    console.log(`${candidates.length} candidate file(s) in ${dir}`);
  }
}

module.exports = { auditCorpus, classifyFile };
