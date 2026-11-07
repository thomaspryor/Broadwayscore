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
const { buildVerificationPrompt, getMarketProfile, resolveMarketSlug, MARKET_PROFILES } = require('./verify-image.js');

const MARKETS = ['broadway', 'off-broadway', 'west-end', 'off-west-end', 'regional'];

// The venue-agnostic profile is an INTERNAL key, deliberately un-typeable as a
// shows.json value (previously 'unknown', which a real category could collide
// with and thereby re-enable Broadway venue rules for a non-Broadway show).
const INTERNAL_PROFILE_KEY = '__venue_agnostic__';

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

test('absent market keeps the Broadway default; an UNRECOGNISED slug does not', () => {
  // Legacy callers passed no market and were all Broadway shows.
  assert.equal(getMarketProfile(undefined), MARKET_PROFILES.broadway);
  assert.equal(getMarketProfile(''), MARKET_PROFILES.broadway);
  // A present-but-unknown slug used to inherit Broadway's reject rules while
  // the prompt label said "(dublin-fringe)" — the exact mislabel this module
  // exists to stop. It gets venue-agnostic rules instead.
  assert.equal(getMarketProfile('dublin-fringe'), MARKET_PROFILES.__venue_agnostic__);
  const prompt = buildVerificationPrompt({ market: 'dublin-fringe' });
  assert.ok(prompt.length > 500);
  assert.match(prompt, /do not reject on venue or company branding at all/);
  assert.ok(
    !/Berkeley Rep|Music Box/.test(prompt),
    'unknown market still leaks Broadway venue expectations',
  );
});

// Re-introduction guard, not a regression test for the market fix: "Live" was
// briefly added to the generic-suffix list to accommodate "Brainiac Live" and
// removed after adversarial review. "Cats Live" is a concert/tour variant, not
// Cats, and the tour rule only fires when tour branding is PRIMARY — so a
// touring card could have passed for the Broadway production. This fails if
// anyone adds it back.
test('"Live" is not listed as a generic same-show suffix (re-introduction guard)', () => {
  for (const market of MARKETS) {
    const prompt = buildVerificationPrompt({ market });
    assert.ok(
      !/"A Memory Play", "Live"/.test(prompt),
      `${market}: "Live" is listed as a generic same-show phrase`,
    );
  }
});

test('the prompt actually DIFFERS by market (not one static prompt for all)', () => {
  // Guards the whole point of the change: if buildVerificationPrompt ever
  // collapses back to a single Broadway prompt, every other market assertion
  // above could still pass on shared boilerplate. This cannot.
  const prompts = new Map(MARKETS.map(m => [m, buildVerificationPrompt({ market: m })]));
  assert.equal(new Set(prompts.values()).size, MARKETS.length, 'two markets produced an identical prompt');
  for (const [m, p] of prompts) {
    if (m === 'broadway') continue;
    assert.ok(
      !p.includes(MARKET_PROFILES.broadway.mismatch),
      `${m} prompt carries Broadway's cross-market mismatch rule verbatim`,
    );
  }
});

test('resolveMarketSlug prefers a recognised category but never discards a good market', () => {
  assert.equal(resolveMarketSlug('off-broadway', 'broadway'), 'off-broadway'); // finer vocabulary wins
  assert.equal(resolveMarketSlug('west-end', 'west-end'), 'west-end');
  // A typo in `category` must NOT disable venue checking when `market` is sound.
  assert.equal(resolveMarketSlug('off-brodway', 'broadway'), 'broadway');
  assert.equal(resolveMarketSlug(null, 'west-end'), 'west-end');
  assert.equal(resolveMarketSlug(undefined, undefined), undefined);
  // Nothing recognisable anywhere still yields the venue-agnostic profile.
  assert.equal(getMarketProfile(resolveMarketSlug('dublin-fringe', 'dublin-fringe')), MARKET_PROFILES.__venue_agnostic__);
});

test('broadway prompt keeps the concrete cross-market counterexamples', () => {
  // Named examples are deterministic reject criteria; "belongs to a different
  // market" alone leaves the call entirely to model inference.
  const prompt = buildVerificationPrompt({ market: 'broadway' });
  for (const name of ['BAM', 'State Theatre New Jersey', 'Gallery Players', 'CenterREP']) {
    assert.ok(prompt.includes(name), `broadway prompt dropped counterexample "${name}"`);
  }
  assert.match(prompt, /community, or touring company branding/);
});

test('the venue-agnostic profile key cannot collide with a real shows.json value', () => {
  assert.ok(MARKET_PROFILES[INTERNAL_PROFILE_KEY], 'internal profile key missing');
  assert.ok(
    !MARKET_PROFILES.unknown,
    "'unknown' is back as a profile key — a category of that value would silently pick it up",
  );
  // A real slug always wins over the internal key, from either field.
  assert.equal(resolveMarketSlug(INTERNAL_PROFILE_KEY, 'west-end'), INTERNAL_PROFILE_KEY);
  assert.equal(resolveMarketSlug('nonsense', 'regional'), 'regional');
});
