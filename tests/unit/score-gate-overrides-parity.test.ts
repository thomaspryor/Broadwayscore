// BRO-7750: the site (src/config/scoring.ts) and the scripts
// (scripts/lib/should-hide-reviews.js) each carry a scoreGateArg. If they drift,
// the show page and the app/feeds disagree on whether a show has a score.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreGateArg as siteGate } from '../../src/config/scoring';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { scoreGateArg: scriptGate } = require('../../scripts/lib/should-hide-reviews.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const overrides = require('../../data/score-gate-overrides.json');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const curated: string[] = require('../../data/curated-historical-shows.json');

test('site scoreGateArg agrees with the scripts copy for every override and sample shows', () => {
  const ids: Array<string | null> = [...Object.keys(overrides.shows), curated[0], 'hamilton-2015', 'no-such-show', '', null];
  assert.ok(Object.keys(overrides.shows).length >= 1);
  for (const id of ids) assert.deepEqual(siteGate(id), scriptGate(id), `scoreGateArg(${JSON.stringify(id)})`);
  for (const id of Object.keys(overrides.shows)) assert.equal(typeof siteGate(id), 'number');
});
