// LIVE-DATA-LANE: reads data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// Split from score-call.test.mjs (BRO-7108): the one test that walks every real show.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SC = require('../../src/lib/score-call.js');
const P = require('../../scripts/lib/review-forecast-pilot.js');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
// Before opening day only: from opening day predictions stay open until a review is live (BRO-7857), the pilot does not.
test('isCallableShow agrees with the pilot predicate on every real show before its opening day', () => {
  const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')).shows;
  let disagree = 0;
  for (const today of ['2025-01-15', '2025-10-01', '2026-03-01', '2026-11-11']) for (const s of shows) { const o = SC.toDay(s.openingDate); if (o != null && SC.toDay(today) >= o) continue; if (SC.isCallableShow(s, today) !== P.isPilotTarget(s, today)) disagree++; }
  assert.equal(disagree, 0);
});
