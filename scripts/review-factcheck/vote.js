#!/usr/bin/env node
'use strict';
/**
 * BRO-5081 review fact-check, step 4: combine the two checkers' answers.
 * A model's answer counts as a vote only if it is cited AND the citation holds:
 * its evidence quote is on the page snapshot, or the URL it cites is one its
 * own search/URL tool actually opened. Agreeing votes decide a check; a split,
 * a missing vote, or an error verdict goes to the adjudication queue, which a
 * human (or the session) settles by reading the page:
 *   data/audit/review-factcheck/adjudications.json  {sampleId: {check: {verdict, note, url}}}
 *
 * Usage: node scripts/review-factcheck/vote.js  -> writes votes.json + prints the queue
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE = process.env.FACTCHECK_CACHE || path.join(os.tmpdir(), 'review-factcheck');
const AUDIT = path.join(ROOT, 'data/audit/review-factcheck');
const CHECKS = ['isReview', 'thisProduction', 'outletMatches', 'criticMatches', 'dateMatches'];
const BUCKETS = ['Pan', 'Negative', 'Mixed', 'Positive', 'Rave'];

const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[‘’“”"'`]/g, '').replace(/&[a-z#0-9]+;/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/** Is the quoted evidence actually on the page? Ellipsis-separated fragments each must match. */
function quoteOnPage(evidence, haystackNorm) {
  const frags = String(evidence || '').split(/\.\.\.|…/).map(norm).filter(f => f.split(' ').length >= 3);
  if (!frags.length) return false;
  return frags.every(f => haystackNorm.includes(f));
}

const domain = u => { try { return new URL(String(u).split(' ')[0]).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** One model's answer to one check -> {answer, counted, why}. */
function judgeVote(ans, page, sources, reviewUrl, outletDomains = []) {
  if (!ans || !['yes', 'no', 'unclear'].includes(ans.answer)) return { answer: null, counted: false, why: 'no answer' };
  if (ans.answer === 'unclear') return { answer: 'unclear', counted: false, why: 'unclear' };
  const cite = String(ans.citation || '').trim();
  if (!cite) return { answer: ans.answer, counted: false, why: 'no citation' };
  // Metadata is offered to the models as "key: value" lines; match it the same way.
  const hay = norm((page.text || '') + ' ' + Object.entries(page.meta || {}).map(([k, v]) => `${k} ${v}`).join(' '));
  if (quoteOnPage(ans.evidence, hay)) return { answer: ans.answer, counted: true, why: 'quote on page' };
  // Cited a page its own tools opened (review domain or an archive of it).
  // Gemini cites vertexaisearch redirect URIs; its grounding chunk's title is the real domain.
  const opened = (sources || []).map(s => { const [u, ...t] = String(s).split(' '); return /vertexaisearch/.test(u) && t.length ? t.join(' ').replace(/^www\./, '') : domain(u); });
  let citeDom = domain(cite);
  if (/vertexaisearch/.test(cite)) {
    const hit = (sources || []).find(s => String(s).split(' ')[0] === cite);
    citeDom = hit ? String(hit).split(' ').slice(1).join(' ').replace(/^www\./, '') : '';
  }
  const reviewDom = domain(reviewUrl);
  // Rows with no URL (Theatre Record texts): the outlet's own site is the review page.
  const okDom = d => d && (d === reviewDom || /archive\.org$/.test(d) || outletDomains.some(od => d === od || d.endsWith('.' + od)));
  if (citeDom && opened.includes(citeDom) && okDom(citeDom))
    return { answer: ans.answer, counted: true, why: 'cited page opened by tool' };
  return { answer: ans.answer, counted: false, why: 'citation does not support (quote not on page, page not opened)' };
}

/** Star/grade text -> CLAUDE.md band, or null. */
function ratingBand(rating) {
  const s = String(rating || '').trim();
  let m = s.match(/(\d(?:\.\d)?)\s*(?:\/|out of)\s*(\d+)/i);
  let frac = null;
  if (m) frac = Number(m[1]) / Number(m[2]);
  else if ((m = s.match(/^(\d(?:\.5)?|one|two|three|four|five)[- ]?(?:stars?)?$/i))) { const w = { one: 1, two: 2, three: 3, four: 4, five: 5 }; frac = (w[m[1].toLowerCase()] || Number(m[1])) / 5; }
  else if ((m = s.match(/^(★+)(½)?(☆*)$/))) {
    // Printed empty stars give the scale (★★★☆ is 3 of 4); bare glyphs are out of 5.
    const scale = m[3] ? m[1].length + (m[2] ? 1 : 0) + m[3].length : 5;
    frac = (m[1].length + (m[2] ? 0.5 : 0)) / scale;
  }
  if (frac == null || !isFinite(frac) || frac > 1) return null;
  if (frac >= 0.9) return [91, 100];
  if (frac >= 0.7) return [71, 90];
  if (frac >= 0.5) return [51, 70];
  if (frac >= 0.3) return [31, 50];
  return [0, 30];
}

const bucketIdx = b => BUCKETS.indexOf(b);
const scoreToBucket = s => s >= 83 ? 'Rave' : s >= 70 ? 'Positive' : s >= 55 ? 'Mixed' : s >= 35 ? 'Negative' : 'Pan';

/**
 * Deterministic page read for c/d/e, used when neither model cast a counted
 * vote but neither said "no": outlet = URL host is the outlet's registered
 * domain (or og:site_name names it); critic = byline/author meta or the text's
 * head/tail names the critic's surname; date = page date within 7 days.
 * Returns 'ok' | 'error' | null (cannot tell).
 */
function deterministicRead(check, item, page, registry) {
  const meta = page.meta || {};
  if (check === 'outletMatches') {
    if (page.source !== 'live' && page.source !== 'live-short') return null;
    const reg = registry[String(item.outletId || '').toLowerCase()] || {};
    const host = domain(page.sourceUrl || item.url);
    const doms = [reg.domain, ...(reg.domainAliases || [])].filter(Boolean).map(d => d.replace(/^www\./, ''));
    if (doms.some(d => host === d || host.endsWith('.' + d))) return 'ok';
    if (meta.siteName && norm(meta.siteName) && (norm(item.outlet).includes(norm(meta.siteName)) || norm(meta.siteName).includes(norm(item.outlet)))) return 'ok';
    return null;
  }
  if (check === 'criticMatches') {
    const name = norm(item.criticName);
    if (!name) return null;
    const surname = name.split(' ').pop();
    const by = norm([meta.byline, meta.metaAuthor, meta.jsonLdAuthor].filter(Boolean).join(' '));
    const text = norm(page.text || '');
    const edges = text.slice(0, 800) + ' ' + text.slice(-500);
    if ((by && by.split(' ').includes(surname)) || (' ' + edges + ' ').includes(' ' + name + ' ')) return 'ok';
    if (by && page.source === 'live' && !by.includes(surname)) return null; // a different byline: leave for a reader
    return null;
  }
  if (check === 'dateMatches') {
    const d = meta.publishDate && Date.parse(String(meta.publishDate).slice(0, 10));
    const ours = item.publishDate && Date.parse(item.publishDate);
    if (!d || !ours) return null;
    return Math.abs(d - ours) <= 7 * 864e5 ? 'ok' : null;
  }
  return null;
}

function judgeScore(item, g, o, page, pageRatings = []) {
  const ours = item.score;
  const ourB = scoreToBucket(ours);
  const votes = [g, o].filter(v => v && v.score && typeof v.score.score === 'number').map(v => ({ score: v.score.score, bucket: scoreToBucket(v.score.score), printed: v.score.printedRating || null, ev: v.score.ratingEvidence }));
  const res = { ours, ourBucket: ourB, models: votes.map(v => ({ score: v.score, bucket: v.bucket, printed: v.printed })), verdict: 'ok', flags: [] };
  if (votes.length < 2) { res.verdict = 'needs-adjudication'; res.flags.push('fewer than two blind scores'); }
  const hay = norm(page.text || '');
  for (const v of votes) {
    const band = ratingBand(v.printed);
    if (!band) continue;
    const onPage = quoteOnPage(v.ev, hay) || hay.includes(norm(v.printed));
    if (!onPage) continue;
    if (ours < band[0] || ours > band[1]) { res.verdict = 'needs-adjudication'; res.flags.push(`printed ${v.printed} -> band ${band.join('-')} but ours ${ours}`); }
  }
  // Ratings found on the real page next to the show's title (verify-ratings.js).
  for (const r of pageRatings.filter(x => x.nearTitle)) {
    const band = ratingBand(r.rating.replace(/stars?/i, '').trim()) || ratingBand(r.rating);
    if (band && (ours < band[0] || ours > band[1])) { res.verdict = 'needs-adjudication'; res.flags.push(`page shows ${r.rating} -> band ${band.join('-')} but ours ${ours}`); }
  }
  if (votes.length === 2) {
    const d = votes.map(v => bucketIdx(v.bucket) - bucketIdx(ourB));
    if (d[0] !== 0 && d[1] !== 0 && Math.sign(d[0]) === Math.sign(d[1])) {
      res.bucketMismatch = true;
      const avg = (votes[0].score + votes[1].score) / 2;
      if (Math.min(Math.abs(d[0]), Math.abs(d[1])) >= 2 || Math.abs(avg - ours) >= 15) { res.verdict = 'needs-adjudication'; res.flags.push(`both models ${votes.map(v => v.bucket).join('/')} (${votes.map(v => v.score).join('/')}) vs ours ${ourB} ${ours}`); }
    }
  }
  return res;
}

function main() {
  const sample = JSON.parse(fs.readFileSync(path.join(AUDIT, 'sample.json'), 'utf8')).sample;
  let registry = {};
  try { registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/outlet-registry.json'), 'utf8')).outlets || {}; } catch { /* no registry */ }
  const read = (m, id) => { const p = path.join(CACHE, 'checks', m, id + '.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
  const ratingsPath = path.join(CACHE, 'ratings.json');
  const ratings = fs.existsSync(ratingsPath) ? JSON.parse(fs.readFileSync(ratingsPath, 'utf8')) : {};
  const out = [];
  const queue = [];
  for (const item of sample) {
    const page = (() => { const p = path.join(CACHE, item.sampleId + '.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { source: 'none', text: '' }; })();
    const G = read('gemini', item.sampleId); const O = read('openai', item.sampleId);
    const g = G && G.parsed; const o = O && O.parsed;
    const row = { sampleId: item.sampleId, stratum: item.stratum, tier: item.tier, showId: item.showId, outlet: item.outlet, criticName: item.criticName, url: item.url, pageSource: page.source, checks: {} };
    for (const c of CHECKS) {
      const reg = registry[String(item.outletId || '').toLowerCase()] || {};
      const outletDomains = [reg.domain, ...(reg.domainAliases || [])].filter(Boolean).map(d => d.replace(/^www\./, ''));
      const vg = judgeVote(g && g[c], page, G && G.sources, item.url, outletDomains);
      const vo = judgeVote(o && o[c], page, O && O.sources, item.url, outletDomains);
      const counted = [vg, vo].filter(v => v.counted);
      let verdict;
      const anyNo = [vg, vo].some(v => v.answer === 'no');
      if (anyNo) verdict = 'needs-adjudication'; // every error claim is read by a person
      else if (counted.some(v => v.answer === 'yes')) verdict = 'ok';
      else {
        const det = deterministicRead(c, item, page, registry);
        verdict = det === 'ok' ? 'ok' : ([vg, vo].every(v => v.answer === 'unclear' || v.answer == null) ? 'unverifiable' : 'needs-adjudication');
        if (det) verdict = det === 'ok' ? 'ok' : verdict;
      }
      // An agreed "no" is an error claim: always read the page before counting it.
      row.checks[c] = { verdict, gemini: vg, openai: vo,
        detail: { gemini: g && g[c] ? (g[c].pageByline || g[c].pageOutlet || g[c].pageDate || g[c].kind || g[c].reason || null) : null, openai: o && o[c] ? (o[c].pageByline || o[c].pageOutlet || o[c].pageDate || o[c].kind || o[c].reason || null) : null } };
    }
    const pr = (ratings[item.sampleId] || { pages: [] }).pages.flatMap(p => p.ratings.map(r => ({ ...r, url: p.url })));
    row.checks.score = judgeScore(item, g, o, page, pr);
    out.push(row);
    const pending = Object.entries(row.checks).filter(([, v]) => v.verdict === 'needs-adjudication').map(([k]) => k);
    if (pending.length) queue.push({ sampleId: item.sampleId, pending });
  }
  fs.writeFileSync(path.join(CACHE, 'votes.json'), JSON.stringify(out, null, 1));
  const tally = {};
  for (const r of out) for (const [c, v] of Object.entries(r.checks)) { tally[c] = tally[c] || {}; tally[c][v.verdict] = (tally[c][v.verdict] || 0) + 1; }
  console.log(JSON.stringify({ rows: out.length, tally, queue: queue.length }, null, 1));
}

if (require.main === module) main();
module.exports = { quoteOnPage, judgeVote, deterministicRead, ratingBand, judgeScore, scoreToBucket, norm };
