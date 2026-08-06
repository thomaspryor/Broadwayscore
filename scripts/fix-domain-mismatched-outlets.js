#!/usr/bin/env node
/**
 * Fix review-text files whose internal outletId is wrong per the URL's domain
 * (audit-review-contamination.js class C — C_domain_mismatch).
 *
 * Root cause (task #1072): task #70 (2026-08-05) added theater.nytimes.com as
 * a domainAlias on the "nytimes" registry entry so that domain resolves for
 * the first time. That made the audit's class-C detector able to see ~140
 * pre-existing files mistagged outletId="about-entertainment" (a real but
 * distinct tier-3 outlet, domain theater.about.com) whose URL is actually
 * theater.nytimes.com — genuine NYT reviews (Ben Brantley, Charles Isherwood,
 * etc.) mistagged at ingest, years before this audit existed. A handful of
 * one-off mistags in other outlets follow the same pattern.
 *
 * Two distinct outcomes per mismatch, decided at run time (this is NOT
 * knowable up front — see below):
 *   - No file already exists at the correct outletId for this show/critic:
 *     RENAME + retag outletId. This was the only record of that review; it
 *     was just filed under the wrong (and wrong-tier) outlet.
 *   - A file already exists at the correct outletId (nytimes--ben-brantley
 *     already on disk for the same show): the mistagged file is a genuine
 *     DUPLICATE of that correct file — same article (same URL path, same
 *     date), independently fetched/scored twice under two different
 *     outletIds, each producing a slightly different LLM score. Discovered
 *     2026-08-06 triaging this exact class: 146 of 138+ about-entertainment
 *     files collide this way, meaning ~146 shows had a single NYT review
 *     double-counted in composite scoring for as long as both files existed.
 *     Fix: mark the mistagged file `duplicateOf` the correct one (matches the
 *     existing corpus convention — see e.g. the-producers-west-end-2025's
 *     times-uk/the-sun pair, `duplicateReason: 'url-collision-detected-at-
 *     write'`). This excludes it from scoring (rebuild-all-reviews.js and
 *     this audit's `alreadyFlagged` both special-case `duplicateOf`) while
 *     preserving the file instead of deleting history.
 *
 * This is a targeted allowlist (MISMATCHES below), not a general "trust the
 * URL domain" migration — every outletId pair was individually verified
 * against the corpus (criticName and/or the file's own `outlet` field
 * independently confirm the true outlet, not just the URL).
 *
 * Usage:
 *   node scripts/fix-domain-mismatched-outlets.js --dry-run
 *   node scripts/fix-domain-mismatched-outlets.js
 */

const fs = require('fs');
const path = require('path');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `fix-domain-mismatched-outlets.js — Fix review-text files mistagged with the
wrong outletId, verified against the article's true URL domain (audit-review-
contamination.js class C). Renames when no correct-outlet file exists yet for
that show/critic; marks duplicateOf when one already does (same article
independently double-scored under two outletIds).

Usage:
  node scripts/fix-domain-mismatched-outlets.js [options]
  node scripts/fix-domain-mismatched-outlets.js --dry-run    list intended changes, do nothing
  node scripts/fix-domain-mismatched-outlets.js --help, -h   print this usage and exit
`;
if (hasHelpFlag(process.argv)) { console.log(USAGE); process.exit(0); }

const DRY_RUN = process.argv.includes('--dry-run');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');

const OUTLET_DISPLAY_NAMES = {
  nytimes: 'The New York Times',
  londontheatredirect: 'Londontheatredirect',
  'scene-on-stage': 'Scene On Stage',
};

const MISMATCHES = [
  // 138 files: outletId="about-entertainment" (tier 3, theater.about.com) but
  // URL is theater.nytimes.com and criticName is a real NYT critic (Ben
  // Brantley x123, Charles Isherwood x30, Bruce Weber, Jason Zinoman). The 4
  // genuine About Entertainment files (Chris Caggiano, theater.about.com) are
  // left untouched — the domain filter below is what protects them.
  { from: 'about-entertainment', to: 'nytimes', domains: ['theater.nytimes.com'] },
  // 5 files: outletId="london-theatre" (real outlet, londontheatre.co.uk) but
  // criticName is literally "London Theatre Direct" / "London Theatre Direct
  // Limited" and the URL is londontheatredirect.com — a different, real
  // tier-3 outlet.
  { from: 'london-theatre', to: 'londontheatredirect', domains: ['londontheatredirect.com'] },
  // 1 file (good-people-2011): outletId="reviewing-the-drama", but
  // criticName=Ben Brantley, url=theater.nytimes.com. Same NYT-mistag class
  // as about-entertainment above.
  { from: 'reviewing-the-drama', to: 'nytimes', domains: ['theater.nytimes.com'] },
  // 1 file (la-cage-aux-folles-2010): outletId="vulture" but criticName=Ben
  // Brantley, url=theater.nytimes.com, and the file's own `outlet` field
  // already reads "New  York Times".
  { from: 'vulture', to: 'nytimes', domains: ['theater.nytimes.com'] },
  // 1 file (the-play-that-goes-wrong-off-broadway-2019): outletId=
  // "susangrangercom" (Susan Granger's site) but criticName=Philip Dorian —
  // scene-on-stage's registered defaultCritic — and url=sceneonstage.com.
  { from: 'susangrangercom', to: 'scene-on-stage', domains: ['sceneonstage.com'] },
];

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

function processOne(showId, file, fromOutlet, toOutlet) {
  const oldFile = path.join(REVIEW_TEXTS_DIR, showId, file);
  const critic = file.replace(/\.json$/, '').split('--').slice(1).join('--');
  const correctFile = path.join(REVIEW_TEXTS_DIR, showId, `${toOutlet}--${critic}.json`);
  if (!exists(oldFile)) return { action: 'skip-not-found', oldFile };

  if (exists(correctFile)) {
    // Duplicate: the correct-outlet copy already exists for this show/critic.
    if (DRY_RUN) return { action: 'would-duplicate', oldFile, correctFile };
    try {
      const j = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
      j.duplicateOf = `${toOutlet}--${critic}.json`;
      j.duplicateReason = `outlet-mismatch: mistagged ${fromOutlet}, same article as ${toOutlet}--${critic}.json (task #1072)`;
      fs.writeFileSync(oldFile, JSON.stringify(j, null, 2) + '\n');
    } catch (e) {
      return { action: 'duplicate-json-error', oldFile, correctFile, error: e.message };
    }
    return { action: 'marked-duplicate', oldFile, correctFile };
  }

  if (DRY_RUN) return { action: 'would-rename', oldFile, correctFile };
  fs.renameSync(oldFile, correctFile);
  try {
    const j = JSON.parse(fs.readFileSync(correctFile, 'utf8'));
    j.outletId = toOutlet;
    if (OUTLET_DISPLAY_NAMES[toOutlet]) j.outlet = OUTLET_DISPLAY_NAMES[toOutlet];
    fs.writeFileSync(correctFile, JSON.stringify(j, null, 2) + '\n');
  } catch (e) {
    return { action: 'renamed-json-error', oldFile, correctFile, error: e.message };
  }
  return { action: 'renamed', oldFile, correctFile };
}

function hostnameOf(url) {
  if (!url || typeof url !== 'string') return null;
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

function main() {
  let showDirs;
  try {
    showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
      try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory(); } catch { return false; }
    });
  } catch (e) {
    console.error(`Cannot read ${REVIEW_TEXTS_DIR}: ${e.message}`);
    process.exit(1);
  }

  const results = { renamed: 0, wouldRename: 0, duped: 0, wouldDupe: 0, skipMissing: 0, errs: 0 };

  for (const rule of MISMATCHES) {
    const prefix = `${rule.from}--`;
    for (const showId of showDirs) {
      const sDir = path.join(REVIEW_TEXTS_DIR, showId);
      let files;
      try { files = fs.readdirSync(sDir).filter(f => f.startsWith(prefix) && f.endsWith('.json')); }
      catch { continue; }
      for (const file of files) {
        let d;
        try { d = JSON.parse(fs.readFileSync(path.join(sDir, file), 'utf8')); } catch { continue; }
        if (d.duplicateOf) continue; // already resolved
        const host = hostnameOf(d.url);
        if (!host || !rule.domains.includes(host)) continue;

        const r = processOne(showId, file, rule.from, rule.to);
        console.log(`  [${r.action}] ${rule.from} -> ${rule.to}  ${showId}/${file}`);
        if (r.action === 'renamed') results.renamed++;
        else if (r.action === 'would-rename') results.wouldRename++;
        else if (r.action === 'marked-duplicate') results.duped++;
        else if (r.action === 'would-duplicate') results.wouldDupe++;
        else if (r.action === 'skip-not-found') results.skipMissing++;
        else if (r.action.endsWith('json-error')) results.errs++;
      }
    }
  }

  console.log('');
  console.log(`Summary: renamed=${results.renamed} would-rename=${results.wouldRename} marked-duplicate=${results.duped} would-duplicate=${results.wouldDupe} skip-not-found=${results.skipMissing} errors=${results.errs}`);
  if (!DRY_RUN && (results.renamed > 0 || results.duped > 0)) {
    console.log('\nNext: cd data/review-texts && git add -A && git commit -m "..." && git push');
  }
}

main();
