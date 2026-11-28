#!/usr/bin/env node
'use strict';
/**
 * BRO-5081: turn the web-search byline sweep (sweep-web-search-bylines.js) plus
 * the hand-verified sample errors into data/pending-fixes/bro-5081-<nn>.json
 * plans of criticName and publishDate edits (25 actions per plan, the executor's cap). Only a
 * single, person-shaped page byline is used; the current file value must still
 * be the swept one (compare-and-set happens again in CI).
 *
 * Usage: node scripts/review-factcheck/make-byline-fix-plans.js [--write] [--issue=bro-5090]
 *          [--text-targets=<path>]
 *
 * --issue names the plans (default bro-5090; bro-5081 was the first pass). --text-targets
 * writes the web-search rows whose page was read but whose stored text is not
 * a real page's worth (textTargets), for collect-review-texts.js REVIEW_FILTER.
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
const argv = Object.fromEntries(process.argv.slice(2).filter(a => a.includes('=')).map(a => a.replace(/^--/, '').split('=')));
const ISSUE = argv.issue || 'bro-5090';
// Every issue that has written plans from this sweep (planLedger).
const SWEEP_ISSUES = ['bro-5081', 'bro-5090'];

// Rows whose stored text was fetched from the wrong page and must be replaced
// even though it is long (collect-review-texts.js skips files with good text
// unless the REVIEW_FILTER entry carries the force: prefix).
const FORCE_TEXT = [
  // fullText is Brantley's 2015 review of the London Donmar run, not the 2016
  // Broadway review at the stored url (BRO-5081 sample).
  'les-liaisons-dangereuses-2016/nytimes--ben-brantley.json',
];

/**
 * A plan may only use a row whose page TITLE names the show. Rows without a
 * stored page or show title (the first curl pass kept neither) used to pass
 * pageIsAboutShow vacuously (no title words to check), which let Variety's
 * legacy CMS bylines through: Robert Koehler, a film critic, for David
 * Rooney's 2008 Little Mermaid review (BRO-5090). Pure.
 */
function pageNamesShow(row) {
  if (!row || !String(row.pageTitle || '').trim() || !String(row.showTitle || '').trim()) return false;
  return pageIsAboutShow(row.pageTitle, '', row.showTitle);
}

const THIN_TIERS = new Set(['excerpt', 'truncated', 'invalid', 'stub', 'needs-rescrape']);

/**
 * Sweep rows whose page we read (any fetcher) but whose stored text is not
 * the review: under 300 chars (the web-search step's invented one-sentence
 * summary; same bar as review-guards isUnverifiableWebSearchRow) or a thin
 * content tier. Returns REVIEW_FILTER entries (showId/file, force: first). Pure.
 */
function textTargets(rows, force = FORCE_TEXT) {
  const reached = rows.filter(r => r.status === 200 && !['off-topic-page', 'unreachable', 'dead-url', 'not-live'].includes(r.verdict));
  const thin = reached.filter(r => typeof r.textLen === 'number' && (r.textLen < 300 || THIN_TIERS.has(r.contentTier)));
  const keys = [...new Set(thin.map(r => `${r.showId}/${r.file}`))].filter(k => !force.includes(k));
  // Every entry is force: so collect-review-texts refetches past its
  // has-good-text skip and flags the replacement for rescore (its excerpt
  // trigger misses thin texts of 500+ chars).
  return [...force, ...keys].map(k => `force:${k}`);
}

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

/**
 * Earlier plans of this sweep (BRO-5081 and this issue). Actions they already
 * carry are never re-emitted: an applied one would be refused by
 * compare-and-set and turn the executor run red, a refused one would be
 * refused again. Plans of this issue still 'pending' are regenerated (stale
 * ones deleted); any other status is kept and numbering continues after it.
 * Pure.
 * @param {{name: string, plan: object}[]} existing parsed data/pending-fixes/*.json
 */
function planLedger(existing, issue, sweepIssues = SWEEP_ISSUES) {
  const seen = new Set();
  const stalePending = [];
  let maxKept = 0;
  const re = new RegExp(`^${issue}-(\\d+)\\.json$`);
  for (const { name, plan } of existing) {
    const own = name.match(re);
    if (own && plan.status === 'pending') { stalePending.push(name); continue; }
    if (own) maxKept = Math.max(maxKept, Number(own[1]));
    if (!own && !sweepIssues.some(i => new RegExp(`^${i}-\\d+\\.json$`).test(name))) continue;
    for (const a of (plan.plan && plan.plan.actions) || []) seen.add(`${a.file}|${a.field}|${JSON.stringify(a.newValue)}`);
  }
  return { seen, stalePending, nextIndex: maxKept + 1 };
}

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
  for (const r of rows.filter(x => x.verdict === 'different' && pageNamesShow(x))) {
    const names = [...new Set(r.bylines.map(cleanByline).filter(Boolean))];
    if (names.length !== 1) { skipped.push([`${r.showId}/${r.file}`, `byline not one person: ${JSON.stringify(r.bylines)}`]); continue; }
    correct(r.showId, r.file, r.outletId, r.url, r.criticName, names[0], `Page byline at ${r.url} is ${names[0]}; ${r.criticName} came from the legacy web-search step and is not on the page.`);
  }
  // Dates: only where the page date sits near the show's opening (judgeDate).
  // The page TITLE must name the show (a url slug can outlive a swapped article:
  // The Crucible's stored url now serves a review of Familiar).
  for (const r of rows.filter(x => x.dateVerdict === 'wrong' && x.verdict !== 'off-topic-page' && pageNamesShow(x))) {
    const d = String(r.pageDate).slice(0, 10);
    const rel = `${r.showId}/${r.file}`;
    const before = actions.length;
    push(rel, r.publishDate, d, `Page date at ${r.url} is ${d} (show opened ${r.openingDate}); ${r.publishDate} came from the legacy web-search step.`, 'publishDate');
    // A provisional source ('llm-scoring', 'roundup-article') would keep the
    // corrected date labelled a guess: date guards ignore it and the next
    // text fetch nulls it. Re-label it as read from the page.
    if (actions.length > before) {
      let cur = null;
      try { cur = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/review-texts', rel), 'utf8')); } catch { cur = null; }
      if (cur && cur.dateSource && cur.dateSource !== 'factcheck-page') push(rel, cur.dateSource, 'factcheck-page', `publishDate ${d} was read from the review page (BRO-5090 sweep).`, 'dateSource');
    }
  }
  for (const f of SAMPLE_FIXES) {
    const [showId, file] = f.file.split('/');
    const rec = showFiles(showId).find(x => x.f === file);
    if (!rec) { skipped.push([f.file, 'missing']); continue; }
    correct(showId, file, rec.outletId, rec.url, f.from, f.to, f.why);
  }
  const dir = path.join(ROOT, 'data/pending-fixes');
  const existing = fs.readdirSync(dir).filter(f => f.endsWith('.json')).flatMap(name => {
    try { return [{ name, plan: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) }]; } catch { return []; }
  });
  const ledger = planLedger(existing, ISSUE);
  const fresh = actions.filter(a => !ledger.seen.has(`${a.file}|${a.field}|${JSON.stringify(a.newValue)}`));
  if (fresh.length < actions.length) console.log(`${actions.length - fresh.length} actions already in earlier plans, not re-emitted`);
  const plans = [];
  for (let i = 0; i < fresh.length; i += MAX_PLAN_ACTIONS) {
    const part = fresh.slice(i, i + MAX_PLAN_ACTIONS);
    const n = ledger.nextIndex + plans.length;
    const id = `${ISSUE}-${String(n).padStart(2, '0')}`;
    plans.push({ id, plan: {
      issueNumber: id, planId: crypto.randomUUID(), status: 'pending', createdAt: new Date().toISOString(),
      submitter: { name: null, email: null },
      plan: {
        summary: `${ISSUE.toUpperCase()} part ${n}: correct ${part.length} critic bylines and publish dates. The legacy LLM web-search step (Feb 2026 backfill) invented them; each review page's own metadata (JSON-LD/meta author, published time) says otherwise.`,
        steps: part.map(a => a.description), riskLevel: 'Low', actions: part,
      } } });
  }
  console.log(JSON.stringify({ actions: fresh.length, plans: plans.length, skipped: skipped.length, skippedSample: skipped.slice(0, 12) }, null, 1));
  if (argv['text-targets']) {
    const t = textTargets(rows);
    fs.writeFileSync(argv['text-targets'], JSON.stringify(t, null, 1) + '\n');
    console.log(`text targets: ${t.length} -> ${argv['text-targets']}`);
  }
  if (WRITE) for (const name of ledger.stalePending) fs.unlinkSync(path.join(dir, name));
  if (WRITE) for (const p of plans) fs.writeFileSync(path.join(ROOT, 'data/pending-fixes', p.id + '.json'), JSON.stringify(p.plan, null, 1) + '\n');
}
if (require.main === module) main();
module.exports = { cleanByline, textTargets, FORCE_TEXT, planLedger, pageNamesShow };
