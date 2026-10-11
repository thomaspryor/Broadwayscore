#!/usr/bin/env node
'use strict';
/**
 * BRO-5081: turn the web-search byline sweep (sweep-web-search-bylines.js) plus
 * the hand-verified sample errors into data/pending-fixes/bro-5081-<nn>.json
 * plans of criticName and publishDate edits (25 actions per plan, the executor's cap). Only a
 * single, person-shaped page byline is used; the current file value must still
 * be the swept one (compare-and-set happens again in CI).
 *
 * Usage: node scripts/review-factcheck/make-byline-fix-plans.js [--write]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { MAX_PLAN_ACTIONS } = require('../lib/pending-fix-limits.js');
const { pageIsAboutShow, compareByline } = require('./sweep-web-search-bylines.js');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE = process.env.FACTCHECK_CACHE || path.join(os.tmpdir(), 'review-factcheck');
const WRITE = process.argv.includes('--write');

/** Page byline -> clean person name, or null when it is not one person. Pure. */
function cleanByline(raw) {
  let s = String(raw || '').replace(/&#0?39;|&#x27;|&rsquo;/g, "'").replace(/&amp;/g, '&').replace(/^\s*by[:\s]+/i, '').trim();
  if (!s || /press|staff|reuters|editor|admin|contributor|\band\b|&|,/i.test(s)) return null;
  const toks = s.split(/\s+/);
  if (toks.length < 2 || toks.length > 4 || toks.some(t => !/^[A-Z][\w'’.-]*$/.test(t))) return null;
  return s;
}

// Sample errors verified in BRO-5081 adjudication but outside the sweep (NYT
// and Newsday pages, a non-web-search file).
const SAMPLE_FIXES = [
  { file: 'the-little-mermaid-2008/nytimes--noel-murray.json', from: 'Noel Murray', to: 'Ben Brantley', why: 'NYT 2008-01-11 review byline is Ben Brantley (archived page); Noel Murray came from a BWW roundup row' },
  { file: 'fish-in-the-dark-2015/nytimes--charles-isherwood.json', from: 'Charles Isherwood', to: 'Ben Brantley', why: 'NYT 2015-03-06 review byline is Ben Brantley (archived page)' },
  { file: 'hand-to-god-2015/nytimes--ben-brantley.json', from: 'Ben Brantley', to: 'Charles Isherwood', why: 'NYT 2015-04-08 review byline is Charles Isherwood (archived page); this web-search file outranked the dtli Isherwood file' },
  { file: 'arcadia-2011/newsday--linda-winer.json', from: 'Linda Winer', to: 'Matt Windman', why: 'newsday.com page byline is Matt Windman' },
  { file: 'here-we-are-west-end-2025/plays-international--maryam-philpott.json', from: 'Maryam Philpott', to: 'Mark Shenton', why: 'playsinternational.org.uk page byline is Mark Shenton' },
];

function main() {
  const rows = JSON.parse(fs.readFileSync(path.join(CACHE, 'web-search-bylines.json'), 'utf8'));
  const actions = [];
  const skipped = [];
  const seen = new Set();
  const push = (rel, from, to, why, field = 'criticName') => {
    const abs = path.join(ROOT, 'data/review-texts', rel);
    if (seen.has(rel + '|' + field)) return;
    let cur;
    try { cur = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { skipped.push([rel, 'missing']); return; }
    if ((cur[field] == null ? null : cur[field]) !== from) { skipped.push([rel, `${field} now ${cur[field]}`]); return; }
    if (cur._locked) { skipped.push([rel, 'locked']); return; }
    seen.add(rel + '|' + field);
    actions.push({ type: 'review-field-edit', file: rel, field, oldValue: from, newValue: to, description: why });
  };
  // Records per show, read once (only the fields used).
  const dirCache = new Map();
  const showFiles = (showId) => {
    if (!dirCache.has(showId)) {
      const dir = path.join(ROOT, 'data/review-texts', showId);
      const files = [];
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); files.push({ f, outletId: j.outletId, criticName: j.criticName, url: j.url, duplicateOf: j.duplicateOf || null }); } catch { /* unreadable */ }
      }
      dirCache.set(showId, files);
    }
    return dirCache.get(showId);
  };
  const normUrl = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  // How to correct `rel` (byline `from`) to `to`:
  //  - a LIVE record for `to` on the SAME url exists -> mark this copy duplicateOf it;
  //  - a live record for `to` on another url exists -> skip (two articles or a
  //    wrong url; a rename would leave two live records for one critic);
  //  - otherwise rename.
  const correct = (showId, file, outletId, url, from, to, why) => {
    const rel = `${showId}/${file}`;
    const same = showFiles(showId).filter(x => x.f !== file && x.outletId === outletId && !x.duplicateOf && compareByline(to, [x.criticName]) === 'match');
    const sameUrl = same.find(x => normUrl(x.url) === normUrl(url));
    if (sameUrl) {
      const self = showFiles(showId).find(x => x.f === file);
      if (!self || self.duplicateOf) { skipped.push([rel, 'already a duplicate']); return; }
      push(rel, null, sameUrl.f, `${why} The page critic already has the live record ${sameUrl.f} for this url, so this web-search copy is a duplicate of it.`, 'duplicateOf');
      return;
    }
    if (same.length) { skipped.push([rel, `page critic already has a live record at another url (${same[0].f})`]); return; }
    push(rel, from, to, why);
  };
  for (const r of rows.filter(x => x.verdict === 'different' && pageIsAboutShow(x.pageTitle, '', x.showTitle))) {
    const names = [...new Set(r.bylines.map(cleanByline).filter(Boolean))];
    if (names.length !== 1) { skipped.push([`${r.showId}/${r.file}`, `byline not one person: ${JSON.stringify(r.bylines)}`]); continue; }
    correct(r.showId, r.file, r.outletId, r.url, r.criticName, names[0], `Page byline at ${r.url} is ${names[0]}; ${r.criticName} came from the legacy web-search step and is not on the page.`);
  }
  // Dates: only where the page date sits near the show's opening (judgeDate).
  // The page TITLE must name the show (a url slug can outlive a swapped article:
  // The Crucible's stored url now serves a review of Familiar).
  for (const r of rows.filter(x => x.dateVerdict === 'wrong' && x.verdict !== 'off-topic-page' && pageIsAboutShow(x.pageTitle, '', x.showTitle))) {
    const d = String(r.pageDate).slice(0, 10);
    push(`${r.showId}/${r.file}`, r.publishDate, d, `Page date at ${r.url} is ${d} (show opened ${r.openingDate}); ${r.publishDate} came from the legacy web-search step.`, 'publishDate');
  }
  for (const f of SAMPLE_FIXES) {
    const [showId, file] = f.file.split('/');
    const rec = showFiles(showId).find(x => x.f === file);
    if (!rec) { skipped.push([f.file, 'missing']); continue; }
    correct(showId, file, rec.outletId, rec.url, f.from, f.to, f.why);
  }
  const plans = [];
  for (let i = 0; i < actions.length; i += MAX_PLAN_ACTIONS) {
    const part = actions.slice(i, i + MAX_PLAN_ACTIONS);
    const n = plans.length + 1;
    const id = `bro-5081-${String(n).padStart(2, '0')}`;
    plans.push({ id, plan: {
      issueNumber: id, planId: crypto.randomUUID(), status: 'pending', createdAt: new Date().toISOString(),
      submitter: { name: null, email: null },
      plan: {
        summary: `BRO-5081 part ${n}: correct ${part.length} critic bylines and publish dates. The legacy LLM web-search step (Feb 2026 backfill) invented them; each review page's own metadata (JSON-LD/meta author, published time) says otherwise.`,
        steps: part.map(a => a.description), riskLevel: 'Low', actions: part,
      } } });
  }
  console.log(JSON.stringify({ actions: actions.length, plans: plans.length, skipped: skipped.length, skippedSample: skipped.slice(0, 12) }, null, 1));
  if (WRITE) for (const p of plans) fs.writeFileSync(path.join(ROOT, 'data/pending-fixes', p.id + '.json'), JSON.stringify(p.plan, null, 1) + '\n');
}
if (require.main === module) main();
module.exports = { cleanByline };
