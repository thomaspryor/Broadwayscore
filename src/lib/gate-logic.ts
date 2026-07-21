/**
 * gate-logic.ts — pure decision functions for the email-capture gate.
 *
 * Extracted per CLAUDE.md §15 so the cooldown and A/B-variant selection are
 * unit-testable without React (tests/unit/gate-logic.test.mjs, tsx batch).
 *
 * Three concerns live here:
 *  1. Passive-gate dismissal cooldown — a visitor who dismissed the popup is
 *     not re-asked for `cooldownDays` (2026-07 audit: dismissal state was
 *     React-state only, so the same person was re-gated EVERY visit — 2,992
 *     exit-intent impressions across 2,150 people, 87% mobile dismissal).
 *  2. Mobile gate timing A/B ('mobile-gate-timing' PostHog flag) — variant
 *     parameter lookup + the ab_variant reporting string. Follows the
 *     TicketButtonsAB conventions: explicit `fallback` label when flags never
 *     load (those users get control BEHAVIOR but are EXCLUDED from analysis —
 *     never silently merged into the control arm), sticky bucketing on.
 *  3. Cold-start page-view gate — no passive trigger fires until the visitor
 *     has viewed a few pages THIS SESSION (2026-07-20 audit: two prior fixes
 *     to #1 above left conversion/dismissal unchanged 6 days later, because
 *     neither touched the real gap — a brand-new visitor's first page load
 *     was eligible for the gate the instant the dwell timer elapsed).
 */

import { emailCaptureConfig } from '@/config/email-capture';

export const MOBILE_GATE_FLAG = 'mobile-gate-timing';

export type MobileGateTiming = 'control' | 'end-of-content' | 'fallback';

export interface MobileGateParams {
  scrollThreshold: number;
  minTimeOnPageSec: number;
  /** What goes into the ab_variant string — 'fallback' means flags never resolved. */
  timing: MobileGateTiming;
}

/**
 * True when a prior dismissal is still within the cooldown window and passive
 * gates (exit_intent / scroll_depth / return_visitor / page_view_limit) must
 * stay quiet. Blocking feature gates (csv/json download) are exempt — they
 * gate an action the user just clicked, not an unsolicited ask.
 *
 * @param dismissedAtRaw localStorage value (ms-epoch string) or null
 * @param nowMs          Date.now()
 * @param cooldownDays   emailCaptureConfig.passiveGateCooldownDays
 */
export function shouldSuppressPassiveGate(
  dismissedAtRaw: string | null,
  nowMs: number,
  cooldownDays: number,
): boolean {
  if (!dismissedAtRaw) return false;
  const dismissedAt = parseInt(dismissedAtRaw, 10);
  if (!Number.isFinite(dismissedAt) || dismissedAt <= 0) return false;
  if (dismissedAt > nowMs) return false; // clock skew / corrupted value — fail open
  return nowMs - dismissedAt < cooldownDays * 24 * 60 * 60 * 1000;
}

/**
 * Resolve the mobile scroll-gate parameters for a PostHog flag value.
 * `null` means the flag never resolved (ad blocker / opt-out / timeout):
 * control BEHAVIOR, `fallback` label so analysis can exclude the cohort.
 * Unknown variant strings also collapse to control behavior (flag typo,
 * stale client) but keep their raw label visible for debugging.
 */
export function getMobileGateParams(flagValue: string | null): MobileGateParams {
  const variants = emailCaptureConfig.mobileScrollGateVariants;
  if (flagValue === 'end-of-content') {
    return { ...variants['end-of-content'], timing: 'end-of-content' };
  }
  if (flagValue === null) {
    return { ...variants.control, timing: 'fallback' };
  }
  return { ...variants.control, timing: 'control' };
}

/**
 * ab_variant reporting string — same `flag:<name>,<dims>` convention as
 * TicketButtonsAB / analyze-ab-test.js VARIANT_RE, so tooling can share the
 * parse and `timing:fallback` rows are excludable with the existing idiom.
 */
export function buildGateAbVariant(timing: MobileGateTiming): string {
  return `flag:${MOBILE_GATE_FLAG},timing:${timing}`;
}

/**
 * True once the visitor has viewed enough pages THIS SESSION for a passive
 * gate to be worth showing. A visitor on their first page load has built zero
 * trust — asking cold there converts near zero and drives the dismiss rate.
 *
 * @param pageViewCount   pages viewed this session (sessionStorage counter)
 * @param minPageViews    emailCaptureConfig.minPageViewsForPassiveGate
 */
export function hasSeenEnoughPages(pageViewCount: number, minPageViews: number): boolean {
  return pageViewCount >= minPageViews;
}

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  LIVE EXPERIMENT — 'gate-cold-start' (started 2026-07-21, PostHog flag)
// Pre-registration: docs/experiments/gate-cold-start.md — read it BEFORE
// touching this block, emailCaptureConfig.minPageViewsForPassiveGate, or the
// cold-start branch in ProGateContext.triggerGate. Mid-experiment changes to
// arm behavior invalidate the test (locked by tests/unit/gate-logic.test.mjs;
// the 2026-07-12 mobile-gate-timing experiment died partly because its
// conditions were never protected — this one is).
// ─────────────────────────────────────────────────────────────────────────────

export const COLD_START_FLAG = 'gate-cold-start';

export type ColdStartArm = 'control' | 'cold-start' | 'fallback';

/**
 * Map the PostHog flag value to an experiment arm. Follows the same
 * conventions as getMobileGateParams: `null`/`undefined` (flag never resolved
 * — ad blocker, opt-out, timeout, or the poll still in flight at fire time)
 * and unknown strings all collapse to 'fallback' — control BEHAVIOR, but
 * EXCLUDED from analysis, never silently merged into the control arm.
 */
export function getColdStartArm(flagValue: string | boolean | null | undefined): ColdStartArm {
  if (flagValue === 'cold-start') return 'cold-start';
  if (flagValue === 'control') return 'control';
  return 'fallback';
}

/**
 * Whether the cold-start page-minimum check applies for this arm.
 * Only the treatment arm gets the 2-page minimum; control and fallback get
 * the pre-2026-07-20 behavior (no minimum) so the control arm is a faithful
 * reproduction of the old funnel.
 */
export function coldStartCheckApplies(arm: ColdStartArm): boolean {
  return arm === 'cold-start';
}

