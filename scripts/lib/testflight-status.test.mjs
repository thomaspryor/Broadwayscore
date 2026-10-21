import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hasCredentials, keyPath, getBuildBetaStatus, SUBMITTED_STATES, EXTERNALLY_VISIBLE_STATES, EXPECTED_PUBLIC_LINK } = require('./testflight-status.js');

// Live App Store Connect check (BRO-88): confirms build 54 was submitted for
// Beta App Review and is visible to external testers via the Public Beta
// group's public link (https://testflight.apple.com/join/CxZYfkyn). Needs
// the ASC private key at ~/.keys/AuthKey_7MPPJ2254M.p8 (or ASC_KEY_PATH) —
// not wired into CI, so it skips there rather than failing.
test('build 54 submitted for Beta App Review and externally visible', async (t) => {
  if (!hasCredentials()) return t.skip(`no ASC credentials at ${keyPath()}`);

  const status = await getBuildBetaStatus('54');
  // TestFlight builds expire after 90 days. Build 54 passed this check while
  // live (BRO-88); once Apple expires it, there is nothing left to verify, so
  // skip instead of failing every local merge's test floor forever.
  if (status.externalBuildState === 'EXPIRED') return t.skip('build 54 has expired on TestFlight (90-day limit)');

  assert.equal(status.submitted, true, `expected build 54 to be submitted, got betaReviewState=${status.betaReviewState}`);
  assert.ok(
    SUBMITTED_STATES.includes(status.betaReviewState),
    `expected betaReviewState in ${SUBMITTED_STATES.join('/')}, got ${status.betaReviewState}`
  );
  assert.ok(
    EXTERNALLY_VISIBLE_STATES.includes(status.externalBuildState),
    `expected externalBuildState in ${EXTERNALLY_VISIBLE_STATES.join('/')}, got ${status.externalBuildState}`
  );
  assert.equal(status.externallyVisible, true, 'expected build 54 to be externally visible');
  assert.equal(status.publicLink, EXPECTED_PUBLIC_LINK, 'expected the known public link, not just any external group');
  assert.equal(status.publicLinkEnabled, true, 'expected the Public Beta group public link to be enabled');
  assert.equal(status.inPublicBetaGroup, true, 'expected build 54 to be a member of the Public Beta group');
});
