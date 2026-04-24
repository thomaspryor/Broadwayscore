#!/usr/bin/env node
/**
 * audit-bww-rr-critic-mismatches.js
 *
 * Scan archived BWW Review Roundup pages for author-byline mis-attributions
 * at single-author outlets — i.e., any authorName that differs from the
 * outlet's `defaultCritic` in outlet-registry.json.
 *
 * Root incident: Rocky Horror 2026-04-23 BWW RR credited "David Finkle,
 * Cote Notices" — Cote Notices is a single-author Substack (David Cote).
 * Session 3 #13 fixed that specific case via scripts/lib/critic-canonicalization.js.
 * This script surfaces NEW candidates proactively so the CRITIC_CANONICAL_MAP
 * grows from evidence, not from opening-night scrambles.
 *
 * Input:  data/aggregator-archive/bww-roundups/*.html + outlet-registry.json
 * Output: stdout table + optional JSON (--json) for workflow consumption
 *
 * Usage:
 *   node scripts/audit-bww-rr-critic-mismatches.js
 *   node scripts/audit-bww-rr-critic-mismatches.js --json > /tmp/bww-audit.json
 *   node scripts/audit-bww-rr-critic-mismatches.js --show=the-rocky-horror-show-2026
 *   node scripts/audit-bww-rr-critic-mismatches.js --since=2026-01-01   (filter by archive mtime)
 */

const fs = require('fs');
const path = require('path');

const { normalizeOutlet, isRegisteredOutlet } = require('./lib/review-normalization');
const { canonicalizeCritic } = require('./lib/critic-canonicalization');

const ROOT = path.join(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'data', 'outlet-registry.json');
const ARCHIVE_DIR = path.join(ROOT, 'data', 'aggregator-archive', 'bww-roundups');

function loadRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8')).outlets || {};
}

/**
 * Small, well-scoped JSON sanitizer that mirrors gather-reviews.js's handling
 * of BWW's unescaped inner quotes. We don't need the full routine — just
 * enough to parse the author field.
 */
function sanitizeJsonLd(s) {
  return s.replace(/[\x00-\x1F\x7F]/g, ' ');
}

/**
 * Parse a BWW RR HTML file for all BlogPosting.author.name pairs + associated
 * outlet hint. Returns array of { authorRaw, outletIdHint, outletRaw, headline }.
 * Uses the same "Critic - Outlet" / "Critic, Outlet" / "Outlet: Critic" format
 * recognition as gather-reviews.js extractBWWRoundupReviews Method 1.
 */
function extractAuthorPairs(html) {
  const out = [];
  const scriptRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    let json;
    try { json = JSON.parse(sanitizeJsonLd(m[1])); } catch { continue; }
    const postings = [];
    if (json['@type'] === 'BlogPosting') postings.push(json);
    else if (json['@type'] === 'LiveBlogPosting' && Array.isArray(json.liveBlogUpdate)) {
      for (const e of json.liveBlogUpdate) if (e['@type'] === 'BlogPosting') postings.push(e);
    }
    for (const posting of postings) {
      const authorName = Array.isArray(posting.author) ? posting.author[0]?.name : posting.author?.name;
      if (!authorName || typeof authorName !== 'string') continue;
      const headline = posting.headline || '';
      // "Outlet - Critic"
      let outletRaw = null, criticName = null;
      if (authorName.includes(' - ')) {
        const parts = authorName.split(' - ');
        outletRaw = parts[0].trim();
        criticName = parts.slice(1).join(' - ').trim() || null;
      } else if (authorName.includes(', ')) {
        // "Critic, Outlet" OR "Outlet, Critic" — try the registered-outlet test.
        const commaIdx = authorName.indexOf(', ');
        const p0 = authorName.slice(0, commaIdx).trim();
        const p1 = authorName.slice(commaIdx + 2).trim();
        if (isRegisteredOutlet(p1)) { outletRaw = p1; criticName = p0; }
        else if (isRegisteredOutlet(p0)) { outletRaw = p0; criticName = p1; }
      } else if (authorName.includes(': ')) {
        const colonIdx = authorName.lastIndexOf(': ');
        const p0 = authorName.slice(0, colonIdx).trim();
        const p1 = authorName.slice(colonIdx + 2).trim();
        if (isRegisteredOutlet(p0)) { outletRaw = p0; criticName = p1; }
        else if (isRegisteredOutlet(p1)) { outletRaw = p1; criticName = p0; }
      }
      if (!outletRaw || !criticName) continue;
      const outletId = normalizeOutlet(outletRaw);
      out.push({ authorRaw: authorName, criticName, outletId, outletRaw, headline });
    }
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const JSON_OUTPUT = argv.includes('--json');
  const verbose = argv.includes('--verbose');
  const showArg = (argv.find(a => a.startsWith('--show=')) || '').slice('--show='.length);
  const sinceArg = (argv.find(a => a.startsWith('--since=')) || '').slice('--since='.length);
  const sinceMs = sinceArg ? new Date(sinceArg).getTime() : null;

  const registry = loadRegistry();
  const singleAuthorOutlets = {};
  for (const [id, o] of Object.entries(registry)) {
    if (o.defaultCritic) singleAuthorOutlets[id] = o.defaultCritic;
  }

  if (!fs.existsSync(ARCHIVE_DIR)) {
    console.error(`No archive dir: ${ARCHIVE_DIR}`);
    process.exit(1);
  }

  let files = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.html'));
  if (showArg) files = files.filter(f => f === `${showArg}.html`);
  if (sinceMs != null) {
    files = files.filter(f => {
      try { return fs.statSync(path.join(ARCHIVE_DIR, f)).mtimeMs >= sinceMs; }
      catch { return false; }
    });
  }

  const findings = [];
  let scanned = 0;
  for (const f of files) {
    const html = fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf-8');
    scanned++;
    const pairs = extractAuthorPairs(html);
    const showId = f.replace(/\.html$/, '');
    for (const p of pairs) {
      const expected = singleAuthorOutlets[p.outletId];
      if (!expected) continue;
      // Already covered by canonicalization map? If canonicalizeCritic
      // upgrades it to the expected critic, the canon path is already handling it — skip.
      const canon = canonicalizeCritic(p.outletId, p.criticName);
      const normalized = canon.canonicalized ? canon.name : p.criticName;
      if (normalized.toLowerCase() === expected.toLowerCase()) continue;
      findings.push({
        showId,
        outletId: p.outletId,
        expectedCritic: expected,
        observedCritic: p.criticName,
        authorRaw: p.authorRaw,
        headline: p.headline,
        alreadyInCanonMap: canon.canonicalized,
      });
    }
  }

  if (JSON_OUTPUT) {
    process.stdout.write(JSON.stringify({ scanned, findings }, null, 2) + '\n');
    return;
  }

  console.log(`Scanned ${scanned} archived BWW RR pages.`);
  console.log(`Single-author outlets monitored: ${Object.keys(singleAuthorOutlets).length}`);
  console.log(`Mismatches found (not yet in CRITIC_CANONICAL_MAP): ${findings.filter(x => !x.alreadyInCanonMap).length}`);
  console.log(`Mismatches already in canon map (for reference): ${findings.filter(x => x.alreadyInCanonMap).length}`);
  console.log('');
  if (findings.length === 0) {
    console.log('(no candidates)');
    return;
  }
  for (const f of findings) {
    const tag = f.alreadyInCanonMap ? '[CANON-MAP]' : '[NEW]     ';
    console.log(`${tag}  show=${f.showId}  outlet=${f.outletId}`);
    console.log(`             observed: "${f.observedCritic}"`);
    console.log(`             expected: "${f.expectedCritic}"  (from outlet-registry.defaultCritic)`);
    console.log(`             authorRaw: "${f.authorRaw}"`);
    if (verbose) console.log(`             headline: "${f.headline}"`);
  }

  // Exit non-zero so CI surfaces new-candidate runs as "needs action"
  const newCount = findings.filter(x => !x.alreadyInCanonMap).length;
  if (newCount > 0) process.exit(2);
}

if (require.main === module) main();

module.exports = { extractAuthorPairs };
