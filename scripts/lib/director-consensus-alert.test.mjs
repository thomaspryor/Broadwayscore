// BRO-7210: director-consensus findings become a worker card; clean clears it; no scan = no decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideDirectorConsensusAlert, DIRECTOR_CONSENSUS_ALERT_KEY } = require('./director-consensus-alert.js');

const f = (o) => ({ showId: 'hamlet-2026', severity: 'STRICT', recorded: 'A B', recordedMentions: 0, totalReviews: 12, proposedDirector: 'C D', proposedDirectorMentions: 9, ...o });

test('STRICT and ZERO route one card; SOFT/REVIEW do not count', () => {
  const d = decideDirectorConsensusAlert([f(), f({ showId: 'x-2026', severity: 'ZERO' }), f({ showId: 'y', severity: 'SOFT' })], 100);
  assert.equal(d.action, 'route');
  assert.equal(d.alert.conditionKey, DIRECTOR_CONSENSUS_ALERT_KEY);
  assert.match(d.alert.title, /^Director consensus: 2 shows/);
  assert.ok(!d.alert.description.includes('y:'));
});
test('clean scan resolves; zero shows scanned yields no decision', () => {
  assert.equal(decideDirectorConsensusAlert([], 100).action, 'resolve');
  assert.equal(decideDirectorConsensusAlert([f({ severity: 'SOFT' })], 100).action, 'resolve');
  assert.equal(decideDirectorConsensusAlert([], 0), null);
});
