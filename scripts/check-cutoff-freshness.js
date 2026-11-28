#!/usr/bin/env node
/**
 * Check freshness of Tony + Olivier eligibility cutoff data.
 *
 * Fails (exit 1) when:
 *   - the CURRENT ceremony's `end` is within FRESHNESS_WINDOW_DAYS of today
 *   - AND the entry's `lastVerified` is more than STALE_THRESHOLD_DAYS old
 *
 * This catches the case where SOLT or the Tony Awards Administration
 * Committee changes a window late in the season and our hard-coded date is
 * silently wrong, biasing the "this season" rank pool.
 *
 * Exits 1 when a record has no lastVerified date or a cutoff is stale
 * (BRO-3040). A ::warning on a green weekly run reached nobody; a red run
 * shows in the morning digest's workflow section and, while it stays red,
 * as a stale CRITICAL_CRONS row (check-cron-health.yml, 200h band).
 *
 * Usage:
 *   node scripts/check-cutoff-freshness.js
 */

const path = require('path');
const { execSync } = require('child_process');

const {
  FRESHNESS_WINDOW_DAYS,
  STALE_THRESHOLD_DAYS,
  findMissingLastVerified,
  findStaleCutoffs,
} = require('./lib/cutoff-freshness.js');

function loadCutoffsViaTsc(tsSrc) {
  // Compile a single .ts file to a temp dir and require the JS. Avoids
  // adding a runtime ts-node dep for this CI-only script.
  const tmpDir = `/tmp/cutoff-freshness-${process.pid}`;
  execSync(`mkdir -p ${tmpDir}`, { stdio: 'inherit' });
  // --resolveJsonModule: tony-cutoffs.ts imports data/tony-ceremony-dates.json
  // (single ceremony-date store). That import makes tsc nest output under the
  // shared root (src/lib/... + data/...), so locate the emitted JS instead of
  // assuming it lands at the outDir top level.
  // The declared typescript, not `npx tsc`: sanity 6 hoists @typescript/old
  // (typescript 6), whose tsc bin wins node_modules/.bin/tsc and rejects these
  // flags (TS5107 moduleResolution=node, TS5112 files + tsconfig) (BRO-6114).
  const tsc = require.resolve('typescript/bin/tsc');
  execSync(
    `"${process.execPath}" "${tsc}" --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --resolveJsonModule --outDir ${tmpDir} ${tsSrc}`,
    { stdio: 'inherit' }
  );
  const baseName = path.basename(tsSrc, '.ts');
  const emitted = execSync(`find ${tmpDir} -name ${baseName}.js`).toString().trim().split('\n')[0];
  if (!emitted) throw new Error(`tsc emitted no ${baseName}.js under ${tmpDir}`);
  return require(emitted);
}

function checkCutoffs(label, records, today) {
  const stale = findStaleCutoffs(records, today);
  for (const { record: r, daysToEnd, daysStale } of stale) {
    console.log(
      `::warning::${label} ${r.label} ends in ${daysToEnd}d but lastVerified is ${daysStale}d old (>${STALE_THRESHOLD_DAYS}d). Re-verify against ${r.source || 'official source'}.`
    );
  }
  return stale.length;
}

function main() {
  const today = new Date().toISOString().slice(0, 10);

  const tony = loadCutoffsViaTsc(
    path.resolve(__dirname, '..', 'src', 'lib', 'tony-cutoffs.ts')
  );
  const olivier = loadCutoffsViaTsc(
    path.resolve(__dirname, '..', 'src', 'lib', 'olivier-cutoffs.ts')
  );

  const tonyRecords = tony.TONY_CUTOFFS;
  const olivierRecords = olivier.OLIVIER_CUTOFFS;

  // BRO-3040: no fallback for a missing lastVerified. Defaulting it to today
  // made the Tony half report fresh forever, so a missing stamp is an error.
  const missing = [
    ...findMissingLastVerified(tonyRecords, today).map((r) => `Tony ${r.label}`),
    ...findMissingLastVerified(olivierRecords, today).map((r) => `Olivier ${r.label}`),
  ];
  if (missing.length > 0) {
    console.log(`::error::${missing.length} cutoff record(s) have no valid lastVerified date (missing, malformed or in the future): ${missing.join(', ')}. Stamp each with the date it was last checked against its source.`);
    process.exit(1);
  }

  let totalWarnings = 0;
  totalWarnings += checkCutoffs('Tony', tonyRecords, today);
  totalWarnings += checkCutoffs('Olivier', olivierRecords, today);

  if (totalWarnings === 0) {
    console.log(`OK — all cutoff windows fresh (checked ${tonyRecords.length} Tony + ${olivierRecords.length} Olivier records, today=${today}).`);
  } else {
    console.log(`${totalWarnings} stale cutoff record(s): re-verify against the source, update the dates if they moved, and stamp lastVerified.`);
  }

  process.exit(totalWarnings > 0 ? 1 : 0);
}

main();
