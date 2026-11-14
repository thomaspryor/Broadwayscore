#!/usr/bin/env node
// Read-only: checks each Deep Research claim against the page it cites, before any of it becomes a
// pending-fixes plan (BRO-5647). A claim is usable only when the page states the figure next to the
// show's title; everything else is listed with the reason so the prompt can be re-asked.
//
//   node scripts/verify-deep-research-claims.js --claims=FILE [--out=FILE] [--max-fetches=N]
//     [--commercial-file=PATH] [--shows-file=PATH]
//   --claims-b64=STRING  the claims as gzip+base64 JSON, for runs through scripts/cloud-run-script.js
//     (cloud sessions hold no scraper keys). Arguments show in the public run: strip quotes first.
//
// FILE is a JSON array of {show, field, value, source_url, quote} (the shape the tracker prompts ask for).
// Write --out outside data/ (scratch or tmp): results quote third-party pages.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { classifyClaim, claimsLoss, normalizeClaim } = require('./lib/deep-research-claim-check');
const { resolveShow, resolveShowMatches } = require('./lib/resolve-show');

const FIELD_ON_RECORD = { capitalization: 'capitalization', 'weekly running cost': 'weeklyRunningCost' };

/** The commercial.json record for a show: keyed by slug (feedback_commercial_slug_keys), with old id keys as a fallback. */
const recordFor = (commercial, show) => (show && (commercial[show.slug] || commercial[show.id])) || null;

/**
 * The show a claim names. A year in brackets ("Proof (2000 Broadway production)") picks the production that
 * opened that year, and none opening that year is no match: a recoupment from 2000 must never land on the 2026 revival.
 */
function showForClaim(name, shows) {
  const year = (String(name).match(/\([^)]*\b((?:19|20)\d{2})\b[^)]*\)/) || [])[1];
  if (!year) return resolveShow(name, shows);
  const sameYear = resolveShowMatches(name, shows).filter(s => String(s.openingDate || s.previewsStartDate || '').startsWith(year));
  return sameYear.length ? resolveShow(name, sameYear) : null;
}

/** How the claim compares with what the live record already says. */
function recordStatus(claim, record) {
  const field = FIELD_ON_RECORD[claim.field];
  if (!record) return 'no-record';
  if (field) {
    if (typeof claim.value !== 'number') return 'n/a';
    if (record[field] == null) return 'new';
    return Math.abs(record[field] - claim.value) < 1 ? 'same' : `differs (record ${record[field]})`;
  }
  if (claim.field === 'outcome for investors') {
    const says = claimsLoss(claim.value) ? false : /recoup/i.test(String(claim.value)) ? true : null;
    if (says === null) return 'n/a';
    if (record.recouped == null) return 'new';
    return record.recouped === says ? 'same' : `differs (record recouped=${record.recouped})`;
  }
  return 'n/a';
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log('verify-deep-research-claims.js --claims=FILE [--out=FILE] [--max-fetches=N]\nRead-only: checks Deep Research claims against the pages they cite.'); return; }
  const flags = Object.fromEntries(argv.map(arg => { const i = arg.indexOf('='); return [arg.slice(2, i < 0 ? undefined : i), i < 0 ? true : arg.slice(i + 1)]; }));
  if (typeof flags.claims !== 'string' && typeof flags['claims-b64'] !== 'string') throw Error('--claims=FILE or --claims-b64=STRING is required');
  const maxFetches = Number(flags['max-fetches'] ?? 80);
  if (!Number.isInteger(maxFetches) || maxFetches < 1) throw Error('--max-fetches must be a positive whole number');
  let json;
  try { json = flags['claims-b64'] ? zlib.gunzipSync(Buffer.from(flags['claims-b64'], 'base64')).toString('utf8') : fs.readFileSync(flags.claims, 'utf8'); } catch (error) { throw Error(`could not read the claims: ${error.message}`); }
  const claims = JSON.parse(json).filter(c => c && c.value != null);
  const shows = JSON.parse(fs.readFileSync(flags['shows-file'] || path.join(__dirname, '../data/shows.json'), 'utf8')).shows;
  const commercial = JSON.parse(fs.readFileSync(flags['commercial-file'] || path.join(__dirname, '../data/commercial.json'), 'utf8')).shows || {};
  const { fetchPage } = require('./lib/scraper');
  const pages = new Map();
  const results = [];
  for (const raw of claims) {
    const claim = normalizeClaim(raw);
    const show = typeof claim.show === 'string' ? showForClaim(claim.show, shows) : null;
    let page = null;
    if (claim.source_url && show) {
      if (!pages.has(claim.source_url)) {
        if (pages.size >= maxFetches) { results.push({ ...raw, verdict: 'not-checked', reason: 'fetch cap reached' }); continue; }
        pages.set(claim.source_url, await fetchPage(claim.source_url).then(r => (r && r.content) || null, () => null));
      }
      page = pages.get(claim.source_url);
    }
    const out = classifyClaim(claim, page, show);
    results.push({ ...raw, slug: show ? show.slug : null, ...out, record: show ? recordStatus(claim, recordFor(commercial, show)) : 'n/a' });
  }
  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  for (const r of results) console.log([r.verdict.padEnd(14), String(r.record).slice(0, 26).padEnd(26), `${r.show} | ${r.field} | ${r.value}`.slice(0, 90), '|', r.reason].join(' '));
  console.log(JSON.stringify(counts));
  if (flags.out) fs.writeFileSync(flags.out, JSON.stringify(results, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { recordStatus, recordFor, showForClaim };
