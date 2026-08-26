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
  getColdStartArm, coldStartCheckApplies, COLD_START_FLAG,
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

// ─── gate-cold-start A/B (LIVE EXPERIMENT since 2026-07-21) ─────────────────

test('cold-start A/B: arm mapping follows the fallback-exclusion convention', () => {
  assert.equal(getColdStartArm('cold-start'), 'cold-start');
  assert.equal(getColdStartArm('control'), 'control');
  // Unresolved / blocked / typo'd flag values must NEVER be silently merged
  // into a real arm — they get control BEHAVIOR but the excluded 'fallback' label.
  assert.equal(getColdStartArm(null), 'fallback', 'flag never resolved → fallback');
  assert.equal(getColdStartArm(undefined), 'fallback', 'poll still in flight → fallback');
  assert.equal(getColdStartArm(true), 'fallback', 'boolean flag (misconfigured) → fallback');
  assert.equal(getColdStartArm('some-typo'), 'fallback', 'unknown variant → fallback');
  assert.equal(COLD_START_FLAG, 'gate-cold-start');
});

test('cold-start A/B: page-minimum applies ONLY to the treatment arm', () => {
  assert.equal(coldStartCheckApplies('cold-start'), true);
  assert.equal(coldStartCheckApplies('control'), false, 'control must reproduce pre-2026-07-20 behavior');
  assert.equal(coldStartCheckApplies('fallback'), false, 'fallback gets control behavior');
});

test('EXPERIMENT LOCK: gate config values are frozen while gate-cold-start runs', () => {
  // ⚠️ If this test failed on your change: a LIVE A/B experiment
  // ('gate-cold-start', started 2026-07-21) depends on these exact values.
  // Changing them mid-experiment silently invalidates the arms and wastes
  // weeks of data — the previous experiment (mobile-gate-timing) died because
  // nothing protected its launch conditions. Read
  // docs/experiments/gate-cold-start.md; conclude or formally amend the
  // experiment there FIRST, then update this lock in the same commit.
  assert.equal(emailCaptureConfig.minPageViewsForPassiveGate, 2,
    'LOCKED: treatment-arm page minimum (see docs/experiments/gate-cold-start.md)');
  assert.equal(emailCaptureConfig.passiveGateCooldownDays, 14,
    'LOCKED: shared cooldown — changing it shifts BOTH arms mid-experiment');
  assert.equal(emailCaptureConfig.exitIntent.enabled, true,
    'LOCKED: disabling exit_intent mid-experiment removes the largest trigger from both arms');
  // Amended BRO-1959, 2026-08-21: gate-cold-start cleared its pre-registered
  // 28-day minimum runtime on 2026-08-18 with clean guardrails (see
  // docs/experiments/gate-cold-start.md "Amendments"). exitIntent's dwell
  // floor is shared across both arms, so raising it doesn't advantage either
  // arm — it just changes the lock value going forward.
  assert.equal(emailCaptureConfig.exitIntent.minTimeOnPageSec, 30,
    'LOCKED: shared exit-intent dwell gate — raised 5->30 post-readout, see docs/experiments/gate-cold-start.md');
  assert.equal(emailCaptureConfig.mobileScrollGate.enabled, true,
    'LOCKED: disabling the scroll gate mid-experiment removes the mobile trigger from both arms');
});

test('EXPERIMENT LOCK: gate-cold-start client wiring intact + no PostHog identity calls in src/', () => {
  // Source-level invariants the config lock can't see (2026-07-21 adversarial
  // review): (1) the arm must still gate the page-minimum and be stamped on
  // events — removing either silently un-blinds the experiment; (2) a
  // posthog.identify()/alias()/reset() call added anywhere in src/ can flip a
  // visitor's flag assignment mid-session, corrupting arm stickiness. If this
  // test blocked you, read docs/experiments/gate-cold-start.md first.
  const ctx = readFileSync(join(SRC_DIR, 'contexts/ProGateContext.tsx'), 'utf8');
  assert.ok(ctx.includes('coldStartCheckApplies(coldStartArm)'),
    'LOCKED: triggerGate must gate the page-minimum on the experiment arm');
  assert.ok(ctx.includes('ab_cold_start: coldStartArm'),
    'LOCKED: triggerGate must stamp the arm on gate events for the analyzer');
  assert.ok(ctx.includes('COLD_START_FLAG'),
    'LOCKED: the flag poll must remain wired');

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
    `LOCKED: posthog.identify/alias/reset calls change distinct_id and can flip a visitor's gate-cold-start arm mid-session. Found in: ${offenders.join(', ')}`);
});
