#!/usr/bin/env node
'use strict';
/**
 * `lane --rehearse` (BRO-4787): replay a fixture through the opening-night lane's full path in dry-run, write the
 * verdict record, and exit 0 on pass / 1 on fail. `--arm-check` reads the recorded rehearsal's record and exits 0 only
 * if the lane may arm.
 *
 *   node scripts/opening-night-lane-rehearse.js --rehearse [--fixture synthetic] [--out data/audit/lane-rehearsal.json]
 *   node scripts/opening-night-lane-rehearse.js --rehearse --fixture recorded [--archive data/aggregator-archive] [--out data/audit/lane-rehearsal-recorded.json]
 *   node scripts/opening-night-lane-rehearse.js --arm-check [--record data/audit/lane-rehearsal-recorded.json] [--max-age-days 8]
 *
 * The arm check reads the RECORDED rehearsal's record (BRO-6619): a synthetic pass never arms a real publish.
 * `--fixture recorded` (BRO-5201) replays real opening nights (scripts/lib/lane-recorded-nights) through the production
 * wiring and checks them against the archived aggregator pages. With no archive it prints SKIPPED, writes nothing and
 * exits 78: a skip is never a pass, and the previous record (if any) ages out on its own.
 */
const path = require('path');
const rehearsal = require('./lib/opening-night-lane/rehearsal');
const { buildSyntheticFixture } = require('./lib/opening-night-lane/rehearsal-fixture');

const REPO = path.join(__dirname, '..');
const EXIT_SKIPPED = 78;
const DEFAULT_RECORD = rehearsal.rehearsalRecordFile(REPO, 'synthetic');
const ARM_RECORD = rehearsal.rehearsalRecordFile(REPO, 'recorded');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };

async function main() {
  if (process.argv.includes('--arm-check')) {
    const days = Number(arg('--max-age-days', '8'));
    const decision = rehearsal.armDecision(rehearsal.readRehearsalRecord(arg('--record', ARM_RECORD)), { maxAgeMs: days * 24 * 60 * 60 * 1000, laneHash: rehearsal.laneCodeHash() });
    console.log(JSON.stringify(decision));
    process.exit(decision.arm ? 0 : 3);
  }
  if (process.argv.includes('--rehearse')) {
    const fixture = arg('--fixture', 'synthetic');
    if (fixture === 'recorded') return rehearseRecorded();
    if (fixture !== 'synthetic') { console.error(`unknown fixture ${fixture}: synthetic or recorded`); process.exit(2); }
    const out = arg('--out', DEFAULT_RECORD);
    const laneHash = rehearsal.laneCodeHash();
    let result;
    try {
      result = await rehearsal.runRehearsal({ fixture: buildSyntheticFixture() });
    } catch (e) {
      // A crash must disarm: leave a FAILED record rather than the previous pass standing for another week.
      rehearsal.recordRehearsal(out, { pass: false }, { kind: 'synthetic', laneHash, error: e && e.message });
      console.error(e && e.stack || e);
      process.exit(2);
    }
    const rec = rehearsal.recordRehearsal(out, result, { kind: 'synthetic', laneHash });
    console.log(JSON.stringify({ pass: rec.pass, checked: rec.checked, failures: rec.failures, checks: rec.checks, modelledMedianMs: result.summary.medianMs, modelledMaxMs: result.summary.maxMs }));
    process.exit(result.pass ? 0 : 1);
  }
  console.error('usage: opening-night-lane-rehearse.js --rehearse | --arm-check');
  process.exit(2);
}
async function rehearseRecorded() {
  const { runRecordedRehearsal } = require('./lib/lane-recorded-nights');
  const out = arg('--out', ARM_RECORD);
  const archiveDir = path.resolve(arg('--archive', path.join(REPO, 'data', 'aggregator-archive')));
  const laneHash = rehearsal.laneCodeHash();
  let result;
  try {
    result = await runRecordedRehearsal({ archiveDir });
  } catch (e) {
    rehearsal.recordRehearsal(out, { pass: false }, { kind: 'recorded', laneHash, error: e && e.message });
    console.error(e && e.stack || e);
    process.exit(2);
  }
  if (result.skipped) {
    console.error(`SKIPPED: recorded rehearsal did not run (${result.reason}). Nothing was recorded; this is not a pass.`);
    process.exit(EXIT_SKIPPED);
  }
  const rec = rehearsal.recordRehearsal(out, result, { kind: 'recorded', laneHash });
  console.log(JSON.stringify({ pass: rec.pass, checked: rec.checked, failures: rec.failures, nights: result.nights }));
  process.exit(result.pass ? 0 : 1);
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(2); });
