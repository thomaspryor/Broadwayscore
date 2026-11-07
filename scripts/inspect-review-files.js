#!/usr/bin/env node
'use strict';
/**
 * inspect-review-files.js — read-only: print the metadata of review-text files
 * for one or more shows (file, outlet, critic, publishDate, dateSource, url,
 * verdict flags, tier, length, content-verifier verdict, 160 chars of text). Built for cloud sessions that have no
 * data/review-texts clone and read it through cloud-run-script.js (BRO-5239).
 *
 *   node scripts/inspect-review-files.js --show=a,b [--outlet=x,y] [--file=sub] [--find=term,term]
 *
 * Each row also carries the stored LLM score and explainExclusion's verdict
 * (the rule that keeps the file out of reviews.json, or null) (BRO-5373).
 *
 * --find (BRO-5243): per term, the character offsets where it occurs in the
 * stored text (case-insensitive), so a two-show column can be confirmed
 * without printing the text.
 */
const fs = require('fs');
const path = require('path');
const { exitOnHelp } = require('./lib/cli-help.js');
exitOnHelp(module);

const ARGV = process.argv.slice(2);
const val = (n) => { const a = ARGV.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3).split(',') : null; };
const class7 = ARGV.includes('--class7'); // the audit's class-7 candidates, with rating context
const root = path.join(__dirname, '..', 'data', 'review-texts');
if (!fs.existsSync(root)) { console.error('data/review-texts missing'); process.exit(3); }
const shows = val('show') || (class7 ? fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : null);
const outlets = val('outlet');
const fileSub = val('file');
const findTerms = val('find');
// BRO-5444: --full prints the whole stored text and every other scalar field
// (source, theatreRecord*, llmScore detail) for a hand re-read. Output is
// sealed to the caller by cloud-run-script; never paste it into public files.
const full = ARGV.includes('--full');
if (!shows) { console.error('usage: inspect-review-files.js --show=a,b [--outlet=x] [--file=sub]'); process.exit(2); }
function findOffsets(text, terms) {
  const lower = text.toLowerCase();
  const out = {};
  for (const term of terms) {
    const t = term.toLowerCase();
    const hits = [];
    for (let i = lower.indexOf(t); i !== -1 && hits.length < 10; i = lower.indexOf(t, i + 1)) hits.push(i);
    out[term] = hits;
  }
  return out;
}
let _showsById = null;
function showFor(id) {
  if (!_showsById) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
      _showsById = Object.fromEntries((Array.isArray(raw) ? raw : (raw.shows || [])).map((x) => [x.id, x]));
    } catch { _showsById = {}; }
  }
  return _showsById[id] || null;
}
// BRO-5395: why the LLM scorer's unscored queue skips a file
// (scoring-queue-counts unscoredSkipReason: already scored, text-gate block,
// sticky rejection, not scoreable, no scorable text), or null when it would score it.
function scorerSkipFor(r, show, filePath) {
  try {
    const showRec = showFor(show);
    return require('./lib/scoring-queue-counts').unscoredSkipReason(r, { show: showRec, showTitle: showRec ? showRec.title : undefined, filePath });
  } catch (e) { return `error: ${e.message}`; }
}
function exclusionFor(r, show, filePath) {
  try {
    return require('./lib/review-guards').explainExclusion(r, showFor(show), filePath);
  } catch (e) { return `error: ${e.message}`; }
}
// BRO-5395: every field explainExclusion / isScoreable can drop a file on
// (rejectionReason, incompleteReason, the other non-review flags,
// showNotMentioned, the scorer's text-gate block), so a skip can be read here.
const FLAGS = ['wrongProduction', 'wrongProductionReason', 'wrongProductionManualClear', 'wrongProductionOverride', 'wrongProductionDetectedBy', '_wrongProductionDetectedBy', 'wrongProductionProvenance', 'wrongProductionDetail', 'wrongProductionAutoCleared', 'wrongProductionAuditCleared', 'humanReviewedWrongProduction', 'allowEarlyDate', 'isRoundupArticle', 'isNonReview', 'wrongShow', 'dateSource', 'duplicateOf',
  'isNotReview', 'nonReviewFlag', 'nonReviewContent', 'nonReviewManualClear', 'rejectionReason', 'rejectedBy', 'rejectedAt', 'incompleteReason', 'showNotMentioned', 'rescoreBlockedReason', 'contentTierReason'];
for (const show of shows) {
  const dir = path.join(root, show);
  if (!fs.existsSync(dir)) { console.log(`## ${show}: no directory`); continue; }
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    if (fileSub && !fileSub.some((s) => f.includes(s))) continue;
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (outlets && !outlets.includes(r.outletId)) continue;
    if (class7) {
      const t = String(r.fullText || '');
      const ev = /\b[0-5](?:\.5)?\s*(?:\/|out of|-)\s*5\b|\bstars?\b|★|☆|five-star|four-star|three-star/i.test(t);
      if (r.originalScoreSource !== 'numeric-stars' || !r.originalScore || ev || r.humanReviewScore) continue;
      if (r.wrongProduction && !r.wrongProductionManualClear && !r.wrongProductionOverride) continue;
      const m = /[^\n]{0,80}\d\s*(?:\/|of)\s*\d[^\n]{0,80}/.exec(t);
      console.log(JSON.stringify({ show, file: f, outletId: r.outletId, originalScore: r.originalScore, scoreSource: r.scoreSource, len: t.length, ctx: m ? m[0] : null, head: t.replace(/\s+/g, ' ').slice(0, 120) }));
      continue;
    }
    const flags = {};
    // An explicit false on these two is a recorded decision the orphaned-provenance
// gate honours (wrongProduction:false, humanReviewedWrongProduction:false), so keep it.
const KEEP_FALSE = new Set(['wrongProduction', 'humanReviewedWrongProduction']);
for (const k of FLAGS) if (r[k] !== undefined && r[k] !== null && (r[k] !== false || KEEP_FALSE.has(k))) flags[k] = r[k];
    console.log(JSON.stringify({
      show, file: f, outletId: r.outletId, critic: r.criticName, pub: r.publishDate,
      url: r.url, flags,
      // BRO-5243: a recovered row is only good when the verifier passed it.
      tier: r.contentTier || null, chars: String(r.fullText || '').length, sourceMethod: r.sourceMethod || null,
      cv: r.contentVerification ? { isValid: r.contentVerification.isValid, confidence: r.contentVerification.confidence, truncated: !!r.contentVerification.truncated, verifiedAt: r.contentVerification.verifiedAt || null } : null,
      text: String(r.fullText || '').replace(/\s+/g, ' ').slice(0, 160),
      llmScore: r.llmScore && r.llmScore.score !== undefined ? r.llmScore.score : null,
      excludedBy: exclusionFor(r, show, path.join(dir, f)),
      scorerSkip: scorerSkipFor(r, show, path.join(dir, f)),
      ...(findTerms ? { find: findOffsets(String(r.fullText || ''), findTerms) } : {}),
      ...(full ? {
        fullText: String(r.fullText || ''),
        fields: Object.fromEntries(Object.entries(r).filter(([k, v]) => k !== 'fullText' && (v === null || typeof v !== 'object'))),
        llmDetail: r.llmScore || null,
      } : {}),
    }));
  }
}
