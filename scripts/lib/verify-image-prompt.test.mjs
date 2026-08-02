/**
 * verify-image-prompt.test.mjs
 *
 * Guards the market-awareness of the show-image verification prompt.
 *
 * Regression this locks down (2026-08-02): the prompt was hardcoded Broadway —
 * "REJECT ... a non-Broadway venue name ... a theater company that is NOT a
 * Broadway producer". For a West End / Off-West-End / Off-Broadway / regional
 * show the CORRECT key art names exactly those venues, so Gemini rejected real
 * posters with [non_broadway] and 26 open/upcoming shows shipped with no image
 * — Brainiac Live (Garrick Theatre) was live on the homepage showing "Images
 * coming soon". Same class as the review-prompt bug fixed in market-label.js.
 *
 * These assert on the REAL buildVerificationPrompt (no copied logic), so a
 * future edit that reintroduces Broadway-only venue rules fails here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildVerificationPrompt, getMarketProfile, MARKET_PROFILES } = require('./verify-image.js');

const MARKETS = ['broadway', 'off-broadway', 'west-end', 'off-west-end', 'regional'];

test('every shows.json market/category slug has its own venue profile', () => {
  for (const m of MARKETS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(MARKET_PROFILES, m),
      `no MARKET_PROFILES entry for "${m}" — it would silently inherit Broadway venue rules`,
    );
  }
});

test('non-Broadway markets are never framed as Broadway productions', () => {
  for (const market of MARKETS.filter(m => m !== 'broadway')) {
    const prompt = buildVerificationPrompt({ market });
    assert.ok(
      !/SPECIFIC Broadway production/i.test(prompt),
      `${market} prompt still frames the show as a Broadway production`,
    );
    // The old rule text. Its presence for a non-Broadway market is the bug.
    assert.ok(
      !/image shows a non-Broadway venue name/i.test(prompt),
      `${market} prompt still carries the Broadway-only venue reject rule`,
    );
  }
});

test('west-end prompt treats London venues as expected, not as a mismatch', () => {
  const prompt = buildVerificationPrompt({ market: 'west-end', venue: 'Garrick Theatre' });
  assert.match(prompt, /West End production at Garrick Theatre/);
  assert.match(prompt, /Old Vic/);            // named as an EXPECTED venue
  assert.match(prompt, /"Garrick Theatre" is this production's venue and is EXPECTED/);
  // A genuine mismatch for a WE show is a Broadway/US venue, not a London one.
  assert.match(prompt, /genuine cross-market mismatch, e\.g\. a Broadway\/New York theatre marquee/);
});

test('off-broadway prompt does not treat an Off-Broadway house as disqualifying', () => {
  const prompt = buildVerificationPrompt({ market: 'off-broadway', venue: 'Pershing Square Signature Center' });
  assert.match(prompt, /Off-Broadway production at Pershing Square Signature Center/);
  assert.match(prompt, /Pershing Square Signature Center/);
  assert.match(prompt, /never a reason to reject/);
});

test('regional prompt treats resident-company branding as the CORRECT signal', () => {
  const prompt = buildVerificationPrompt({ market: 'regional', venue: 'La Jolla Playhouse' });
  assert.match(prompt, /La Jolla Playhouse/);
  assert.match(prompt, /regional theater logo is the CORRECT signal/i);
  // The tour rule must not fire on the production's own out-of-town city.
  assert.match(prompt, /own theater and city on the poster is expected/);
  assert.ok(
    !/"National Tour", "US Tour", "UK Tour"/.test(prompt),
    'regional prompt keeps the Broadway tour-branding rule, which rejects its own city',
  );
});

test('broadway prompt keeps its original guardrails', () => {
  const prompt = buildVerificationPrompt({ market: 'broadway' });
  assert.match(prompt, /Broadway production/);
  assert.match(prompt, /Manhattan Theatre Club/);       // accepted producers preserved
  assert.match(prompt, /Berkeley Rep|Goodman Theatre/);  // regional = mismatch for Broadway
  assert.match(prompt, /"National Tour", "US Tour", "UK Tour"/);
});

test('shared rules survive in every market prompt', () => {
  for (const market of MARKETS) {
    const prompt = buildVerificationPrompt({ market });
    assert.match(prompt, /DIFFERENT SHOW's title/, `${market}: wrong-show check lost`);
    assert.match(prompt, /yellow PLAYBILL program cover/, `${market}: playbill-cover check lost`);
    assert.match(prompt, /Coming soon/, `${market}: placeholder check lost`);
    assert.match(prompt, /production_still/, `${market}: production-photo check lost`);
    assert.match(prompt, /Issue categories:/, `${market}: response contract lost`);
  }
});

test('unknown or missing market falls back to the Broadway profile without throwing', () => {
  assert.equal(getMarketProfile(undefined), MARKET_PROFILES.broadway);
  assert.equal(getMarketProfile('dublin-fringe'), MARKET_PROFILES.broadway);
  assert.ok(buildVerificationPrompt().length > 500);
});
