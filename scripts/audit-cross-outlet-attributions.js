#!/usr/bin/env node
/**
 * audit-cross-outlet-attributions.js — find review-text files plausibly
 * carrying ANOTHER outlet's critic (Carmen class, 2026-08-03).
 *
 * Confirmed instance: carmen-off-broadway-2025/parterre-box--david-salazar.json
 * was credited to operawire's defaultCritic; the actual page byline was
 * Gabrielle Ferrari. Aggregators (BWW roundups, DTLI, Playbill verdicts,
 * Show-Score) sometimes credit the wrong outlet/critic pair, and with no
 * scraped fullText nothing contradicts them.
 *
 * A file is a suspect when ALL hold:
 *   1. criticName equals a DIFFERENT outlet's registry defaultCritic
 *   2. source is aggregator-derived (bww-roundup / show-score* / dtli /
 *      playbill-verdict / outlet-listing-poller)
 *   3. no stored fullText backs the byline
 *   4. the critic appears at this outlet at most once in reviews.json
 *      (legit syndication/freelancing shows repeat appearances)
 *
 * Files annotated with `crossOutletVerified: true` (set after a human/agent
 * checked the page byline) are skipped — that is how triaged legit rows are
 * cleared. Files annotated with `wrongAttribution: true` (unverifiable —
 * broken/missing source URL, byline points to neither the stored critic nor
 * any confirmed replacement) are also skipped — review-guards.js and
 * rebuild-all-reviews.js already exclude wrongAttribution:true from scoring.
 * Exit code 1 when unreviewed suspects remain, 0 when clean, so the
 * count is machine-checkable:
 *   node scripts/audit-cross-outlet-attributions.js            report + exit code
 *   node scripts/audit-cross-outlet-attributions.js --json     JSON to stdout
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');

if (hasHelpFlag(process.argv)) {
  console.log(
    'audit-cross-outlet-attributions.js — list files plausibly credited to another outlet\'s critic.\n\n' +
      'Usage: node scripts/audit-cross-outlet-attributions.js [--json]\n' +
      'Exit 1 when unreviewed suspects remain, 0 when clean.\n' +
      'Clear a verified-legit row by setting crossOutletVerified: true in the file.\n' +
      'Clear an unverifiable row by setting wrongAttribution: true in the file.'
  );
  process.exit(0);
}

// cwd, not __dirname: the canonical (gitignored) data/review-texts store only
// exists in the main checkout — run from the repo root that owns it.
// Disposable worktrees (autonomous-acceptance-recheck's prepareCheckWorkdir
// copies only flat data/*.json, never the review-texts tree) exit 3 — the
// repo's "cannot verify here" convention (see check-health-row-absent.js) —
// instead of crashing with ENOENT and masquerading as a real failure.
const ROOT = process.cwd();
for (const required of ['data/review-texts', 'data/reviews.json', 'data/outlet-registry.json']) {
  if (!fs.existsSync(path.join(ROOT, required))) {
    console.error(`cannot verify: ${required} not present under ${ROOT} — run from the main checkout`);
    process.exit(3);
  }
}
const AGG = ['playbill-verdict', 'show-score', 'bww-roundup', 'dtli', 'outlet-listing-poller'];

const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'outlet-registry.json'), 'utf8')).outlets;
const defaultOf = new Map();
for (const [oid, entry] of Object.entries(registry)) {
  if (entry.defaultCritic) {
    if (!defaultOf.has(entry.defaultCritic)) defaultOf.set(entry.defaultCritic, []);
    defaultOf.get(entry.defaultCritic).push(oid);
  }
}

const reviews = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reviews.json'), 'utf8')).reviews;
const perOutletCritic = new Map();
for (const r of reviews) {
  const key = `${r.outletId}||${r.criticName}`;
  perOutletCritic.set(key, (perOutletCritic.get(key) || 0) + 1);
}

const reviewTexts = path.join(ROOT, 'data', 'review-texts');
const suspects = [];
for (const showId of fs.readdirSync(reviewTexts)) {
  if (showId.startsWith('_') || showId.startsWith('.')) continue;
  const dir = path.join(reviewTexts, showId);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    const { criticName, outletId } = d;
    if (!criticName || !outletId || criticName === 'Unknown') continue;
    if (d.crossOutletVerified === true) continue;
    if (d.wrongAttribution === true) continue;
    const homes = defaultOf.get(criticName) || [];
    if (!homes.length || homes.includes(outletId)) continue;
    const src = String(d.source || '');
    if (!AGG.some((a) => src.includes(a))) continue;
    if (d.fullText) continue;
    if ((perOutletCritic.get(`${outletId}||${criticName}`) || 0) > 1) continue;
    suspects.push({
      file: `${showId}/${file}`,
      criticName,
      defaultCriticOf: homes,
      source: src,
      url: d.url || null,
    });
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ count: suspects.length, suspects }, null, 2));
} else {
  for (const s of suspects) {
    console.log(`  ${s.file} | ${s.criticName} (default of ${s.defaultCriticOf.join(',')}) | ${s.source} | ${s.url || 'no url'}`);
  }
  console.log(`${suspects.length} unreviewed cross-outlet suspect(s)`);
}
// process.exitCode (not process.exit()) lets Node drain the stdout pipe
// before exiting — execFileSync callers piping large --json payloads saw
// truncated/empty stdout when this called process.exit() directly.
process.exitCode = suspects.length > 0 ? 1 : 0;
