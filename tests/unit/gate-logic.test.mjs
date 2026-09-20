/**
 * Gate-logic contract tests (email-capture cooldown + mobile-timing A/B).
 * Runs in the tsx unit batch (test.yml) — imports src TS directly per the
 * outlet-id-mapper precedent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../src');

const {
  shouldSuppressPassiveGate, hasSeenEnoughPages,
  getMobileGateParams, buildGateAbVariant, MOBILE_GATE_FLAG,
} = await import('../../src/lib/gate-logic.ts');
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

test('cold-start: passive gate withheld until the visitor has seen enough pages this session', () => {
  assert.equal(hasSeenEnoughPages(0, 2), false, 'first page load → too cold');
  assert.equal(hasSeenEnoughPages(1, 2), false, 'still on page 1 → too cold');
  assert.equal(hasSeenEnoughPages(2, 2), true, 'second page → eligible');
  assert.equal(hasSeenEnoughPages(5, 2), true, 'well past threshold → eligible');
  assert.equal(hasSeenEnoughPages(0, 0), true, 'threshold of 0 → always eligible (config off switch)');
});

test('config: minPageViewsForPassiveGate present and sane in the active preset', () => {
  // 2026-07-20 audit: neither prior fix (dismissal cooldown, exit-intent dwell
  // gate) required any session engagement before a passive ask — a brand-new
  // visitor's first page load was eligible instantly. Guard against regressing
  // back to a cold-start ask.
  assert.equal(typeof emailCaptureConfig.minPageViewsForPassiveGate, 'number');
  assert.ok(emailCaptureConfig.minPageViewsForPassiveGate >= 2,
    'passive gates must wait for at least a second page view this session');
});

// ─── gate-cold-start page-minimum (concluded A/B, permanent default since 2026-09-15) ───

test('wiring: triggerGate applies the page-view minimum unconditionally (post gate-cold-start conclusion)', () => {
  // gate-cold-start ran 2026-07-21 to 2026-09-15 as a 50/50 A/B (page-minimum
  // vs no minimum); concluded in favor of applying the minimum to ALL
  // traffic — see docs/experiments/gate-cold-start.md "Conclusion". This
  // string-match follows the same wiring-check convention as the mobile-timing
  // tests below (no React test harness in this repo yet); it exists so a
  // future edit can't silently reintroduce arm branching without a test
  // noticing the removed call.
  const ctx = readFileSync(join(SRC_DIR, 'contexts/ProGateContext.tsx'), 'utf8');
  assert.ok(ctx.includes('hasSeenEnoughPages(sessionPageViewsRef.current, emailCaptureConfig.minPageViewsForPassiveGate)'),
    'triggerGate must still gate passive triggers on the page-view minimum');
  assert.ok(!/coldStartCheckApplies|getColdStartArm|COLD_START_FLAG|ab_cold_start/.test(ctx),
    'gate-cold-start arm-branching was concluded 2026-09-15 and must not be reintroduced — see docs/experiments/gate-cold-start.md');
});

test('no PostHog identity calls in src/ (protects sticky bucketing for live experiments)', () => {
  // A posthog.identify()/alias()/reset() call anywhere in src/ can flip a
  // visitor's flag assignment mid-session, corrupting arm stickiness for
  // whichever experiment is live at the time (mobile-gate-timing,
  // ticket-single-button, ticket-primary-platform, or any future one) — a
  // general invariant, not specific to any one experiment.
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      // Strip comment lines first — TicketLink.tsx legitimately WARNS about
      // identify() in a comment; only actual code calls are violations.
      const code = readFileSync(p, 'utf8').split('\n')
        .filter(l => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
        .map(l => l.replace(/\/\/.*$/, ''))
        .join('\n');
      if (/posthog\s*[.?]+\s*(identify|alias|reset)\s*\(/.test(code)) offenders.push(p);
    }
  };
  walk(SRC_DIR);
  assert.deepEqual(offenders, [],
    `posthog.identify/alias/reset calls change distinct_id and can flip a visitor's live-experiment arm mid-session. Found in: ${offenders.join(', ')}`);
});
