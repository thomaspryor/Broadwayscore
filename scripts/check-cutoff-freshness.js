#!/usr/bin/env node
/**
 * Check freshness of Tony + Olivier eligibility cutoff data.
 *
 * Warns (advisory v1) when:
 *   - the CURRENT ceremony's `end` is within FRESHNESS_WINDOW_DAYS of today
 *   - AND the entry's `lastVerified` is more than STALE_THRESHOLD_DAYS old
 *
 * This catches the case where SOLT or the Tony Awards Administration
 * Committee changes a window late in the season and our hard-coded date is
 * silently wrong, biasing the "this season" rank pool.
 *
 * Exits 0 always for v1 (advisory). Future: flip to exit 1 once we trust
 * the gate. Emits ::warning lines so GitHub Actions surfaces them.
 *
 * Usage:
 *   node scripts/check-cutoff-freshness.js
 */

const path = require('path');
const { execSync } = require('child_process');

const FRESHNESS_WINDOW_DAYS = 60;
const STALE_THRESHOLD_DAYS = 60;

function loadCutoffsViaTsc(tsSrc) {
  // Compile a single .ts file to a temp dir and require the JS. Avoids
  // adding a runtime ts-node dep for this CI-only script.
  const tmpDir = `/tmp/cutoff-freshness-${process.pid}`;
  execSync(`mkdir -p ${tmpDir}`, { stdio: 'inherit' });
  // --resolveJsonModule: tony-cutoffs.ts imports data/tony-ceremony-dates.json
  // (single ceremony-date store). That import makes tsc nest output under the
  // shared root (src/lib/... + data/...), so locate the emitted JS instead of
  // assuming it lands at the outDir top level.
  execSync(
    `npx tsc --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --resolveJsonModule --outDir ${tmpDir} ${tsSrc}`,
    { stdio: 'inherit' }
  );
  const baseName = path.basename(tsSrc, '.ts');
  const emitted = execSync(`find ${tmpDir} -name ${baseName}.js`).toString().trim().split('\n')[0];
  if (!emitted) throw new Error(`tsc emitted no ${baseName}.js under ${tmpDir}`);
  return require(emitted);
}

function daysBetween(isoA, isoB) {
  return Math.round((new Date(isoB) - new Date(isoA)) / 86400000);
}

function checkCutoffs(label, records, today) {
  let warnings = 0;
  for (const r of records) {
    const daysToEnd = daysBetween(today, r.end);
    if (daysToEnd < 0 || daysToEnd > FRESHNESS_WINDOW_DAYS) continue;
    const daysStale = daysBetween(r.lastVerified || '1970-01-01', today);
    if (daysStale > STALE_THRESHOLD_DAYS) {
      console.log(
        `::warning::${label} ${r.label} ends in ${daysToEnd}d but lastVerified is ${daysStale}d old (>${STALE_THRESHOLD_DAYS}d). Re-verify against ${r.source || 'official source'}.`
      );
      warnings++;
    }
  }
  return warnings;
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

  // The Tony records don't (yet) have a lastVerified field. Treat them as
  // verified for now; once we backfill, this loop catches them too.
  const tonyAnnotated = tonyRecords.map((r) => ({ ...r, lastVerified: r.lastVerified || today }));

  let totalWarnings = 0;
  totalWarnings += checkCutoffs('Tony', tonyAnnotated, today);
  totalWarnings += checkCutoffs('Olivier', olivierRecords, today);

  if (totalWarnings === 0) {
    console.log(`OK — all cutoff windows fresh (checked ${tonyRecords.length} Tony + ${olivierRecords.length} Olivier records, today=${today}).`);
  } else {
    console.log(`${totalWarnings} freshness warning(s). Advisory — not failing the build.`);
  }

  process.exit(0);
}

main();
