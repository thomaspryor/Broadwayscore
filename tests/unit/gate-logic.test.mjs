/**
 * Gate-logic contract tests (email-capture cooldown + mobile-timing A/B).
 * Runs in the tsx unit batch (test.yml) — imports src TS directly per the
 * outlet-id-mapper precedent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { shouldSuppressPassiveGate, getMobileGateParams, buildGateAbVariant, MOBILE_GATE_FLAG } =
  await import('../../src/lib/gate-logic.ts');
const { emailCaptureConfig } = await import('../../src/config/email-capture.ts');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

test('cooldown: suppresses within the window, releases after it', () => {
  const days = 14;
  assert.equal(shouldSuppressPassiveGate(String(NOW - 1 * DAY), NOW, days), true, '1 day after dismiss → quiet');
  assert.equal(shouldSuppressPassiveGate(String(NOW - 13.9 * DAY), NOW, days), true, 'day 13.9 → still quiet');
  assert.equal(shouldSuppressPassiveGate(String(NOW - 14.1 * DAY), NOW, days), false, 'day 14.1 → may ask again');
});

test('cooldown: fails OPEN on missing/corrupt/skewed values (never permanently silences capture)', () => {
  assert.equal(shouldSuppressPassiveGate(null, NOW, 14), false, 'no stamp → show');
  assert.equal(shouldSuppressPassiveGate('garbage', NOW, 14), false, 'corrupt stamp → show');
  assert.equal(shouldSuppressPassiveGate('-500', NOW, 14), false, 'negative → show');
  assert.equal(shouldSuppressPassiveGate(String(NOW + 5 * DAY), NOW, 14), false, 'future stamp (clock skew) → show');
});

test('config: passiveGateCooldownDays present and sane in the active preset', () => {
  assert.equal(typeof emailCaptureConfig.passiveGateCooldownDays, 'number');
  assert.ok(emailCaptureConfig.passiveGateCooldownDays >= 7 && emailCaptureConfig.passiveGateCooldownDays <= 90);
});

test('config: exit-intent has a non-zero dwell gate in the active preset', () => {
  // 2026-07-14 audit: exit_intent was the largest gate trigger by volume
  // (2,253 shown/30d) with NO minimum dwell time — a mouse move toward the
  // tab bar milliseconds after load counted as "exit intent." Guard against
  // regressing back to an instant-fire listener.
  assert.equal(typeof emailCaptureConfig.exitIntent.minTimeOnPageSec, 'number');
  assert.ok(emailCaptureConfig.exitIntent.minTimeOnPageSec >= 3,
    'exit intent must wait at least a few seconds before arming');
});

test('A/B params: end-of-content variant differs from control ONLY as configured, and keeps a scroll-restore guard', () => {
  const control = getMobileGateParams('control');
  const variant = getMobileGateParams('end-of-content');
  assert.equal(control.timing, 'control');
  assert.equal(variant.timing, 'end-of-content');
  assert.deepEqual(
    { scrollThreshold: control.scrollThreshold, minTimeOnPageSec: control.minTimeOnPageSec },
    emailCaptureConfig.mobileScrollGateVariants.control,
    'control arm must equal the config (current production behavior)');
  assert.ok(variant.scrollThreshold > control.scrollThreshold, 'variant fires later in the page');
  assert.ok(variant.minTimeOnPageSec >= 2,
    'variant needs >=2s min-time — guards against instant fire on back-navigation scroll restore');
});

test('A/B fallback: unresolved flag gets control BEHAVIOR but the fallback LABEL (excluded from analysis, never merged into control)', () => {
  const fb = getMobileGateParams(null);
  assert.equal(fb.timing, 'fallback');
  assert.deepEqual(
    { scrollThreshold: fb.scrollThreshold, minTimeOnPageSec: fb.minTimeOnPageSec },
    emailCaptureConfig.mobileScrollGateVariants.control);
  // Unknown flag value (typo / stale client) → control behavior, control label
  assert.equal(getMobileGateParams('some-typo').timing, 'control');
});

test('ab_variant string follows the flag:<name>,<dims> convention shared with analyze-ab-test tooling', () => {
  assert.equal(buildGateAbVariant('end-of-content'), `flag:${MOBILE_GATE_FLAG},timing:end-of-content`);
  assert.equal(buildGateAbVariant('fallback'), `flag:${MOBILE_GATE_FLAG},timing:fallback`);
  assert.match(buildGateAbVariant('control'), /^flag:mobile-gate-timing,timing:control$/);
});
