#!/usr/bin/env node

/**
 * Apply manually-verified decisions from cross-referencing the 33 recent
 * wsj wrong_content files (task #841) against data/audit/wsj-theater-review-index.json
 * (WSJ's own Theater Review + Opera Review section crawl, 2025-01-01 to present).
 *
 * Each file was checked by hand against the index: does WSJ's own catalog carry
 * a review matching this specific production (by title token overlap + venue/date
 * sanity), or does the index prove no such review exists (title genuinely absent,
 * or the only match is for a DIFFERENT production of the same title — e.g. an
 * earlier Broadway run when we need a West End review, or a prior Met revival
 * when we need this season's run)?
 *
 * Decisions:
 *   - 'confirmed': stored URL is WSJ's own indexed review of this exact production.
 *     No URL change. Caller refetches full text separately (recover-wsj-browser.js
 *     or the direct extractArticle path for files it skips due to wrongShow/
 *     wrongProduction flags).
 *   - 'wrong-attribution': index proves no review of this production exists (title
 *     absent, or only match is a different production/run). Stamps
 *     wrongAttribution:true + wrongAttributionReason with evidence. No URL change
 *     (the old URL stays on file as a breadcrumb of what was checked and rejected).
 *   - 'future-show': show has not opened yet (or opens after the crawl's date
 *     floor) — no review can exist. Stamps noWsjReviewYet:true + reason. NOT
 *     wrongAttribution, so a later automated pass can retry after opening.
 *
 * Usage: node scripts/wsj-apply-index-decisions.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const { hasHelpFlag } = require('./lib/cli-help');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(`wsj-apply-index-decisions.js — apply manually-verified WSJ index decisions (task #841).

Usage: node scripts/wsj-apply-index-decisions.js [--dry-run]

  --dry-run   print what would change without writing any review files`);
  process.exit(0);
}

const dryRun = process.argv.includes('--dry-run');
const REVIEW_TEXTS_DIR = '/Users/tompryor/Broadwayscore/data/review-texts';
const INDEX_PATH = path.join(__dirname, '..', 'data', 'audit', 'wsj-theater-review-index.json');

const { safeWriteReview } = require('./lib/review-write-guard');

const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
const CRAWL_EVIDENCE = `Checked against WSJ's own Theater Review + Opera Review section index ` +
  `(crawled ${index.crawledAt.slice(0, 10)}, covers ${index.minDate} to present, ` +
  `${index.totalUnique} reviews across both sections; see data/audit/wsj-theater-review-index.json).`;

const DECISIONS = [
  { file: 'bug-2026/wsj--charles-isherwood.json', decision: 'confirmed',
    note: 'URL matches WSJ index exactly (Charles Isherwood, "Bug" review). Stored fullText was a truncated preview; needs refetch.' },
  { file: 'john-proctor-is-the-villain-2025/wsj--charles-isherwood.json', decision: 'confirmed',
    note: 'URL matches WSJ index exactly. Stored fullText was truncated (527 chars); needs refetch.' },
  { file: 'carmen-off-broadway-2025/wsj--heidi-waleson.json', decision: 'confirmed',
    note: 'URL matches WSJ index exactly (byline: Heidi Waleson). Needs refetch (fullText null).' },
  { file: 'carmen-off-broadway-2025/wsj--justin-davidson.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} WSJ's index lists this exact URL/headline under byline "Heidi Waleson", not Justin Davidson — critic misattribution / duplicate URL entry (same #241 multi-critic URL dedup class). Canonical review lives in wsj--heidi-waleson.json.` },
  { file: 'don-giovanni-off-broadway-2025/wsj--heidi-waleson.json', decision: 'confirmed',
    note: 'URL matches WSJ index exactly (byline: Heidi Waleson). Needs refetch (fullText null).' },

  { file: 'cosi-fan-tutte-off-broadway-2026/wsj--heidi-waleson.json', decision: 'future-show',
    reason: `Show opens 2026-09-23 (status: upcoming) — has not opened as of ${index.crawledAt.slice(0, 10)}, no review can exist yet. ${CRAWL_EVIDENCE} The only "Così fan tutte" match in the index (with 'The Threepenny Opera') is dated to an earlier Met revival, not this run.` },
  { file: 'gloria-2026/wsj--terry-teachout.json', decision: 'future-show',
    reason: `Show opens 2027-04-05 (status: upcoming) — has not opened, no review can exist yet. ${CRAWL_EVIDENCE} No "Gloria" review in the index; stored URL is Terry Teachout's 2015 "On Your Feet" review (about Gloria Estefan, an unrelated show) — Teachout died Jan 2022.` },
  { file: 'miss-saigon-west-end-2026/wsj--terry-teachout.json', decision: 'future-show',
    reason: `Show opens 2027-05-27 (status: upcoming) — has not opened, no review can exist yet. ${CRAWL_EVIDENCE} No "Miss Saigon" review in the index; stored URL is Terry Teachout's 2017 review of an earlier run — Teachout died Jan 2022.` },

  { file: 'arcadia-west-end-2026/wsj--terry-teachout.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} No "Arcadia" review in the index. Stored URL is a Terry Teachout byline (died Jan 2022) predating this 2026 Old Vic revival; WSJ rarely covers West End productions.` },
  { file: 'beetlejuice-west-end-2026/wsj--edward-rothstein.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} No "Beetlejuice" review in the index for this West End transfer. Stored URL is Edward Rothstein's 2019 review of the original Broadway production.` },
  { file: 'building-the-wall-off-broadway-2026/wsj--terry-teachout.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} No "Building the Wall" review in the index. Stored URL is Terry Teachout's 2017 review of the original premiere run (Teachout died Jan 2022); file already carries wrongProduction ("Pre-opening guard: review dated 2017-05-25 is 90+ days before show starts 2026-06-11") for this 2026 Urban Stages revival.` },
  { file: 'caroline-off-broadway-2026/wsj--anna-mundow.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} No "Caroline" review in the index for this MCC Theater run (opened 2025-10-01, within crawl coverage). Stored URL is an unrelated WSJ book review ("Lady Caroline Lamb").` },
  { file: 'cyrano-de-bergerac-west-end-2026/wsj--terry-teachout.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} No "Cyrano de Bergerac" review in the index. Stored URL is a Terry Teachout byline (died Jan 2022) predating this 2026 Noël Coward Theatre run; WSJ rarely covers West End productions.` },
  { file: 'end-of-the-rainbow-west-end-2026/wsj--terry-teachout.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} No "End of the Rainbow" review in the index. Stored URL is a Terry Teachout byline (died Jan 2022) predating this 2026 Soho Theatre Walthamstow run.` },
  { file: 'glengarry-glen-ross-west-end-2026/wsj--unknown.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} The only "Glengarry Glen Ross" match in the index is Charles Isherwood's Mar 31 2025 review "Kieran Culkin, Back on Broadway" — the Broadway revival, not this 2026 Old Vic (West End) production. No URL was stored (critic: unknown).` },
  { file: 'la-traviata-off-broadway-2026/wsj--charles-isherwood.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} No "La Traviata" review in the index for the Mar 2026 Met run (within crawl coverage). Stored URL is undated/stale.` },
  { file: 'la-traviata-off-broadway-2026/wsj--heidi-waleson.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} No "La Traviata" review in the index for the Mar 2026 Met run (within crawl coverage). Stored URL is Heidi Waleson's 2018 review of an earlier Met revival.` },
  { file: 'les-liaisons-dangereuses-west-end-2026/wsj--terry-teachout.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} No "Les Liaisons Dangereuses" review in the index. Stored URL is a Terry Teachout byline (died Jan 2022) predating this 2026 National Theatre (Lyttelton) run.` },
  { file: 'mass-west-end-2026/wsj--anvee-bhutani.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} No "Mass" review in the index for this 2026 Donmar Warehouse run (within crawl coverage). Stored URL is an unrelated WSJ piece about "Sunday Mass" as a NYC social trend.` },
  { file: 'oh-mary-west-end-2025/wsj--charles-isherwood.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} The only "Oh, Mary!" match in the index is Charles Isherwood's review of the original Broadway production (Cole Escola) — not this Dec 2025 Trafalgar Theatre (West End) transfer.` },
  { file: 'porgy-and-bess-off-broadway-2025/wsj--heidi-waleson.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} No "Porgy and Bess" review in the index for the Dec 2025 Met run (within crawl coverage). Stored URL is Heidi Waleson's 2019 review of the production's premiere.` },
  { file: 'pride-west-end-2026/wsj--brian-p-kelly.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} No "Pride" review in the index for this 2026 Dorfman Theatre (National Theatre) run (within crawl coverage). Stored URL is an unrelated WSJ art review ("Folk Nation" exhibit).` },
  { file: 'pride-west-end-2026/wsj--unknown.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} No "Pride" review in the index for this 2026 Dorfman Theatre (National Theatre) run (within crawl coverage). Stored URL is the same unrelated WSJ art review as the sibling file.` },
  { file: 'romeo-and-juliet-west-end-2026/wsj--terry-teachout.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} The only "Romeo and Juliet" matches in the index are Charles Isherwood's Shakespeare-in-the-Park (Central Park) and Broadway (Zegler/Connor) reviews — neither is this 2026 Harold Pinter Theatre (West End) production. Stored URL is a Teachout byline (died Jan 2022).` },
  { file: 'romeo-and-juliet-west-end-2026/wsj--unknown.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} Same as sibling file: only Broadway/Central Park matches exist in the index, none for this 2026 West End production.` },
  { file: 'small-off-broadway-2026/wsj--charles-isherwood.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} No "Small" review in the index for the May 2026 Signature Center run (within crawl coverage). Stored URL ("Pay the Writer and Small") predates the crawl window entirely.` },
  { file: 'spamalot-off-broadway-2026/wsj--charles-isherwood.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} The "Spamalot" match in the index is Charles Isherwood's review of the Broadway revival — not this touring engagement at State Theatre New Jersey; WSJ does not review individual touring stops.` },
  { file: 'sting-west-end-2026/wsj--unknown.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} No "Sting" review in the index for this 2026 run (within crawl coverage). Stored URL was a WSJ live stock-market-coverage page (unrelated).` },
  { file: 'the-potluck-off-broadway-2026/wsj--spencer-cox-and-eboo-patel.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} No "The Potluck" review in the index for this June 2026 Soho Rep run (within crawl coverage). Stored URL is an unrelated WSJ Opinion piece.` },
  { file: 'the-price-off-west-end-2026/wsj--unknown.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} No "The Price" review in the index for this 2026 Marylebone Theatre run (within crawl coverage). Stored URL was a WSJ futures market-data quote page (unrelated).` },
  { file: 'to-kill-a-mockingbird-west-end-2026/wsj--terry-teachout.json', decision: 'wrong-attribution',
    reason: `${CRAWL_EVIDENCE} No "To Kill a Mockingbird" review in the index. Stored URL is a Terry Teachout byline (died Jan 2022) reviewing the original Broadway production, not this 2026 Wyndham's Theatre run.` },
];

console.log(`Applying ${DECISIONS.length} decisions${dryRun ? ' (DRY RUN)' : ''}...\n`);

const results = { confirmed: [], 'wrong-attribution': [], 'future-show': [], errors: [] };

for (const d of DECISIONS) {
  const filePath = path.join(REVIEW_TEXTS_DIR, d.file);
  if (!fs.existsSync(filePath)) {
    console.log(`SKIP (missing) ${d.file}`);
    results.errors.push(d.file);
    continue;
  }

  if (d.decision === 'confirmed') {
    console.log(`CONFIRMED (refetch separately): ${d.file}`);
    results.confirmed.push(d.file);
    continue;
  }

  const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const patch = d.decision === 'future-show'
    ? { noWsjReviewYet: true, noWsjReviewYetReason: d.reason, noWsjReviewYetCheckedAt: index.crawledAt }
    : { wrongAttribution: true, wrongAttributionReason: d.reason, wrongAttributionCheckedAt: index.crawledAt };

  console.log(`${d.decision.toUpperCase()}: ${d.file}`);
  console.log(`  ${d.reason}\n`);

  if (!dryRun) {
    const result = safeWriteReview(filePath, patch, { merge: true });
    if (!result.wrote) {
      console.log(`  WARNING: write skipped (locked?) for ${d.file}`);
      results.errors.push(d.file);
      continue;
    }
  }
  results[d.decision].push(d.file);
}

console.log('\n=== Summary ===');
console.log(`Confirmed (needs refetch): ${results.confirmed.length}`);
console.log(`Wrong attribution: ${results['wrong-attribution'].length}`);
console.log(`Future show: ${results['future-show'].length}`);
console.log(`Errors: ${results.errors.length}`);
if (results.errors.length) console.log(results.errors);
