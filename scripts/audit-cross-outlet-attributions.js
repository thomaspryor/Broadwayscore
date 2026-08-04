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
 *
 * --include-fulltext (card 3b2637c5-416f-81e6, 2026-08-04): the base scan
 * above explicitly skips files WITH stored fullText on the assumption that a
 * directly-scraped page is less likely to carry an aggregator's wrong byline.
 * A full-corpus query found that assumption false at scale — 5,094 of 6,234
 * criticName-vs-registry mismatches HAVE fullText. This flag scans that
 * population, scoped to T1/T2 (the file's outletId OR the critic's
 * registered home is tier 1/2 per the canonical getTier() lookup — NOT the
 * data/outlet-registry.json tier field alone, see outlet-tiers.js) since
 * that's the highest-value slice. It drops the AGG source-allowlist (this
 * population's sources are far more varied than the original 5) and instead
 * verifies inline: does the stored fullText actually contain the critic's
 * name (normalized, diacritic/punctuation-insensitive)? A match means the
 * byline is confirmed in the text itself and the file is NOT a suspect. The
 * repeat-appearance exclusion (>1 occurrence of this outletId+criticName pair
 * in reviews.json) still applies — it's the single strongest signal that a
 * "mismatch" is actually a critic's real, long-standing home that the
 * registry's defaultCritic annotation just isn't recorded against (e.g.
 * Matt Windman has 345 reviews at amny, but defaultCritic is recorded on the
 * near-empty duplicate outletId "amnewyorkcom" instead — a registry gap, not
 * a misattribution).
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { getTier } = require('./lib/outlet-tiers');
const { normalizeCriticForCoverage } = require('./lib/multi-critic-serp');

// Byline zone for the --include-fulltext inline-verify check. A plain
// whole-body substring search (ship-check adversarial finding, 2026-08-04)
// wrongly auto-cleared book-of-mormon-2011/guardian--david-cote.json: its
// text merely CITES "David Cote is chief theatre critic of Time Out New
// York" as an authority quote 2845 chars in, nowhere near an actual byline —
// yet the loose match silently marked it verified-forever. Real bylines
// cluster in two zones: a leading "By NAME" / "Review by NAME" line (most
// outlets), or a trailing "--NAME OutletName, address" signature block
// (confirmed pattern: lighting-sound-america). Restrict the match to those.
const LEADING_BYLINE_CHARS = 400;
function bylineConfirmedInFullText(criticName, fullText) {
  const normCritic = normalizeCriticForCoverage(criticName);
  if (!normCritic || !fullText) return false;
  const text = String(fullText);
  if (normalizeCriticForCoverage(text.slice(0, LEADING_BYLINE_CHARS)).includes(normCritic)) {
    return true;
  }
  // Trailing/inline signature: "by NAME", "--NAME", or an em/en-dash before
  // NAME, anywhere in the raw text. Built from the individual name tokens so
  // punctuation/whitespace drift in scraped text (double spaces, curly
  // apostrophes) doesn't break the match the way a literal-string search would.
  const nameTokens = String(criticName)
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!nameTokens.length) return false;
  const namePattern = nameTokens.join('[\\s.]+');
  const signatureRe = new RegExp(`(?:\\bby\\s+|--\\s*|[\\u2013\\u2014]\\s*)${namePattern}\\b`, 'i');
  return signatureRe.test(text);
}

// --include-fulltext tier scoping needs the show's market (NYC vs London)
// — getTier() defaults to NYC when no showCategory is passed, which would
// misclassify a London-tiered outlet (e.g. The Stage: NYC=2, London=1) for
// West End shows. Load once; missing/legacy shows fall back to the NYC
// default via getTier's own handling of an undefined showCategory.
const showCategoryOf = new Map();
{
  const showsPath = path.join(process.cwd(), 'data', 'shows.json');
  if (fs.existsSync(showsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
      const arr = Array.isArray(raw) ? raw : raw.shows;
      for (const s of arr || []) {
        if (s && s.id) showCategoryOf.set(s.id, s.category);
      }
    } catch {
      // best-effort — falls back to NYC default tier for every show
    }
  }
}

if (hasHelpFlag(process.argv)) {
  console.log(
    'audit-cross-outlet-attributions.js — list files plausibly credited to another outlet\'s critic.\n\n' +
      'Usage: node scripts/audit-cross-outlet-attributions.js [--json] [--include-fulltext]\n' +
      'Exit 1 when unreviewed suspects remain, 0 when clean.\n' +
      'Clear a verified-legit row by setting crossOutletVerified: true in the file.\n' +
      'Clear an unverifiable row by setting wrongAttribution: true in the file.\n' +
      '--include-fulltext scans T1/T2 fullText-present reviews the base scan skips (card 3b2637c5-416f-81e6).'
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

const INCLUDE_FULLTEXT = process.argv.includes('--include-fulltext');

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
    if ((perOutletCritic.get(`${outletId}||${criticName}`) || 0) > 1) continue;

    if (INCLUDE_FULLTEXT) {
      if (!d.fullText) continue;
      const tierOpts = { showCategory: showCategoryOf.get(showId) };
      const inT1T2 = getTier(outletId, tierOpts) <= 2 || homes.some((h) => getTier(h, tierOpts) <= 2);
      if (!inT1T2) continue;
      if (bylineConfirmedInFullText(criticName, d.fullText)) continue;
      suspects.push({
        file: `${showId}/${file}`,
        criticName,
        defaultCriticOf: homes,
        source: String(d.source || ''),
        url: d.url || null,
        mode: 'fulltext',
      });
      continue;
    }

    const src = String(d.source || '');
    if (!AGG.some((a) => src.includes(a))) continue;
    if (d.fullText) continue;
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
