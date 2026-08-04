#!/usr/bin/env node
/**
 * audit-aggregator-url-latent.js — ratchet on the LATENT aggregator-URL population.
 *
 * WHY THIS EXISTS (task #1002, 2026-08-04 main-red incident):
 * `validate-review-texts.js --gate` treats "URL is an aggregator listing page but
 * outletId is a real outlet" as a zero-tolerance error. It only ever sees files in the
 * validated population — every review carrying an exclusion flag (wrongProduction,
 * duplicateOf, ...) is skipped before any check runs.
 *
 * That is how main went red on 2026-08-04 with nobody having pushed a bad file:
 * witness-for-the-prosecution-west-end-2022/artsdesk--unknown.json had stored the
 * stagedoor.com listing URL for months while flagged wrongProduction. Task #1017's
 * sweep auto-cleared the flag, the file joined the validated population, and a
 * months-old defect became a trunk failure with no human in the loop.
 *
 * A corpus scan at fix time found 10 MORE files in exactly that state. Each is one
 * auto-clear away from repeating the incident. This guard makes that population a
 * ratchet: it may shrink, never grow. A new one means a producer just wrote an
 * aggregator listing URL under a real outletId — fix the producer, not the ceiling.
 *
 * Deliberately NOT a zero-tolerance gate on the existing 10: they are excluded
 * tombstones that reach neither scoring nor the site, and failing the trunk on
 * pre-existing tombstones would redden main for every unrelated push — the exact
 * pathology that forced validate-review-texts.js onto a floor in the first place.
 *
 * Usage:
 *   node scripts/audit-aggregator-url-latent.js           # exit 1 if the population grew
 *   node scripts/audit-aggregator-url-latent.js --json    # machine-readable summary
 *   node scripts/audit-aggregator-url-latent.js --help    # usage only, no side effects
 *
 * Exit codes: 0 = at or below the pinned ceiling, 1 = growth or a malformed pin.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const USAGE = `audit-aggregator-url-latent.js — ratchets the latent aggregator-URL population.

Usage:
  node scripts/audit-aggregator-url-latent.js
  node scripts/audit-aggregator-url-latent.js --json      print a JSON summary
  node scripts/audit-aggregator-url-latent.js --help, -h  print this usage and exit

Counts review-text files whose url is on an aggregator domain while outletId names a
real outlet, split into:
  live   — in the validated population; validate-review-texts.js --gate already fails on these
  latent — hidden behind an exclusion flag; invisible today, one auto-clear from going live

Fails when latent exceeds the ceiling in scripts/.aggregator-url-latent.json. To lower
the ceiling after fixing files, update "latentCeiling" to the new count.`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const { listShowDirs } = require('./lib/list-show-dirs');
const { classifyReview, evaluateLatentPopulation } = require('./lib/aggregator-url-latent');

const REPO_ROOT = path.join(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(REPO_ROOT, 'data', 'review-texts');
const PIN_PATH = path.join(__dirname, '.aggregator-url-latent.json');

const asJson = process.argv.includes('--json');

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exitCode = 1;
}

function scanCorpus() {
  const live = [];
  const latent = [];
  let scanned = 0;

  for (const showId of listShowDirs(REVIEW_TEXTS_DIR, { silent: true })) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try {
      files = fs.readdirSync(showDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'failed-fetches.json') continue;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf-8'));
      } catch {
        // Corrupt/unreadable JSON is validate-review-texts.js's problem, not ours.
        continue;
      }
      scanned++;
      const verdict = classifyReview(data);
      if (verdict === 'live') live.push(`${showId}/${file}`);
      else if (verdict === 'latent') latent.push(`${showId}/${file}`);
    }
  }
  return { scanned, live, latent };
}

function main() {
  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    fail(`review-texts not found at ${path.relative(REPO_ROOT, REVIEW_TEXTS_DIR)} — run scripts/setup-local-data.sh`);
    return;
  }

  let pin;
  try {
    pin = JSON.parse(fs.readFileSync(PIN_PATH, 'utf-8'));
  } catch (e) {
    fail(`cannot read ${path.relative(REPO_ROOT, PIN_PATH)}: ${e.message}`);
    return;
  }

  const { scanned, live, latent } = scanCorpus();
  const verdict = evaluateLatentPopulation(latent.length, pin.latentCeiling);

  if (asJson) {
    console.log(JSON.stringify({
      scanned,
      live: live.length,
      latent: latent.length,
      latentCeiling: pin.latentCeiling,
      ok: verdict.ok,
      reason: verdict.reason,
      ratchetTo: verdict.ratchetTo,
      liveFiles: live,
      latentFiles: latent,
    }, null, 2));
  } else {
    console.log(`Scanned ${scanned} review-text files`);
    console.log(`  live aggregator-URL mismatches:   ${live.length}`);
    console.log(`  latent (behind exclusion flags):  ${latent.length} (ceiling ${pin.latentCeiling})`);
    if (live.length) {
      // Not this guard's failure to own — validate-review-texts.js --gate fails the
      // trunk on these. Printed so one command gives the whole picture.
      console.log('\nLIVE (validate-review-texts.js --gate fails on these):');
      live.forEach((f) => console.log(`  ${f}`));
    }
    if (latent.length) {
      console.log('\nLATENT (invisible to the gate until an auto-clear promotes them):');
      latent.forEach((f) => console.log(`  ${f}`));
    }
    console.log('');
  }

  if (!verdict.ok) {
    fail(verdict.reason);
    if (latent.length > pin.latentCeiling && !asJson) {
      console.error('::error::Fix the new file(s) and the producer that wrote them. Raising latentCeiling to go green re-arms the exact trunk failure this guard exists to stop.');
    }
    return;
  }

  if (verdict.ratchetTo !== null) {
    console.log(`::notice::${verdict.reason} Set "latentCeiling" to ${verdict.ratchetTo} in ${path.relative(REPO_ROOT, PIN_PATH)}.`);
  } else if (!asJson) {
    console.log(`✅ ${verdict.reason}`);
  }
}

main();
