#!/usr/bin/env node
'use strict';
/**
 * inspect-review-files.js — read-only: print the metadata of review-text files
 * for one or more shows (file, outlet, critic, publishDate, dateSource, url,
 * verdict flags, tier, length, content-verifier verdict, 160 chars of text). Built for cloud sessions that have no
 * data/review-texts clone and read it through cloud-run-script.js (BRO-5239).
 *
 *   node scripts/inspect-review-files.js --show=a,b [--outlet=x,y] [--file=sub]
 */
const fs = require('fs');
const path = require('path');
const { exitOnHelp } = require('./lib/cli-help.js');
exitOnHelp(module);

const ARGV = process.argv.slice(2);
const val = (n) => { const a = ARGV.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3).split(',') : null; };
const class7 = ARGV.includes('--class7'); // the audit's class-7 candidates, with rating context
const shows = val('show') || (class7 ? fs.readdirSync(path.join(__dirname, '..', 'data', 'review-texts')) : null);
const outlets = val('outlet');
const fileSub = val('file');
if (!shows) { console.error('usage: inspect-review-files.js --show=a,b [--outlet=x] [--file=sub]'); process.exit(2); }

const root = path.join(__dirname, '..', 'data', 'review-texts');
if (!fs.existsSync(root)) { console.error('data/review-texts missing'); process.exit(3); }
const FLAGS = ['wrongProduction', 'wrongProductionReason', 'wrongProductionManualClear', 'wrongProductionOverride', 'allowEarlyDate', 'isRoundupArticle', 'isNonReview', 'wrongShow', 'dateSource', 'duplicateOf'];
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
    for (const k of FLAGS) if (r[k] !== undefined && r[k] !== null && r[k] !== false) flags[k] = r[k];
    console.log(JSON.stringify({
      show, file: f, outletId: r.outletId, critic: r.criticName, pub: r.publishDate,
      url: r.url, flags,
      // BRO-5243: a recovered row is only good when the verifier passed it.
      tier: r.contentTier || null, chars: String(r.fullText || '').length, sourceMethod: r.sourceMethod || null,
      cv: r.contentVerification ? { isValid: r.contentVerification.isValid, confidence: r.contentVerification.confidence, truncated: !!r.contentVerification.truncated, verifiedAt: r.contentVerification.verifiedAt || null } : null,
      text: String(r.fullText || '').replace(/\s+/g, ' ').slice(0, 160),
    }));
  }
}
