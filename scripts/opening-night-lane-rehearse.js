#!/usr/bin/env node
'use strict';
/**
 * `lane --rehearse` (BRO-4787): replay a fixture through the opening-night lane's full path in dry-run, write the
 * verdict record, and exit 0 on pass / 1 on fail. `--arm-check` reads that record and exits 0 only if the lane may arm.
 *
 *   node scripts/opening-night-lane-rehearse.js --rehearse [--fixture synthetic] [--out data/audit/lane-rehearsal.json]
 *   node scripts/opening-night-lane-rehearse.js --arm-check [--record data/audit/lane-rehearsal.json] [--max-age-days 8]
 */
const path = require('path');
const rehearsal = require('./lib/opening-night-lane/rehearsal');
const { buildSyntheticFixture } = require('./lib/opening-night-lane/rehearsal-fixture');

const DEFAULT_RECORD = path.join(__dirname, '..', 'data', 'audit', 'lane-rehearsal.json');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };

async function main() {
  if (process.argv.includes('--arm-check')) {
    const days = Number(arg('--max-age-days', '8'));
    const decision = rehearsal.armDecision(rehearsal.readRehearsalRecord(arg('--record', DEFAULT_RECORD)), { maxAgeMs: days * 24 * 60 * 60 * 1000, laneHash: rehearsal.laneCodeHash() });
    console.log(JSON.stringify(decision));
    process.exit(decision.arm ? 0 : 3);
  }
  if (process.argv.includes('--rehearse')) {
    if (arg('--fixture', 'synthetic') !== 'synthetic') { console.error('only the synthetic fixture exists until a real opening is recorded (BRO-4787 follow-up)'); process.exit(2); }
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
main().catch((e) => { console.error(e && e.stack || e); process.exit(2); });
