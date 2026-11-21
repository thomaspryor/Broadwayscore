// BRO-7424 class guard: a lane test that runs on the REAL clock (`now: () => Date.now()`) must not pin NIGHT to a
// literal date. The lane stamps seenAt from that clock and isLaneReview trusts it only within a few days of the night
// (trust-model.js SEEN_AFTER_DAYS), so such a test passes for four days and then goes red on main with no code change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

export function fixedNightOnRealClock(src) {
  return /\bnow:\s*\(\)\s*=>\s*Date\.now\(\)/.test(src) && /\bconst\s+NIGHT\s*=\s*['"]\d{4}-\d{2}-\d{2}['"]/.test(src);
}

test('the detector flags a literal night with a real clock, and accepts a derived night or a fake clock', () => {
  assert.equal(fixedNightOnRealClock("const NIGHT = '2026-11-09';\n now: () => Date.now(),"), true);
  assert.equal(fixedNightOnRealClock('const NIGHT = new Date().toISOString().slice(0, 10);\n now: () => Date.now(),'), false);
  assert.equal(fixedNightOnRealClock("const NIGHT = '2026-11-09';\n now: () => t,"), false);
});

test('no lane test pairs a literal NIGHT with the real clock', () => {
  const bad = fs.readdirSync(dir)
    .filter((f) => /^(lane-|opening-night-lane).*\.test\.mjs$/.test(f) && f !== path.basename(fileURLToPath(import.meta.url)))
    .filter((f) => fixedNightOnRealClock(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(bad, [], 'derive NIGHT from today (new Date().toISOString().slice(0, 10)) or inject a fake clock');
});
