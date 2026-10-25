/**
 * gate-logic.ts — pure decision functions for the email-capture gate.
 *
 * Extracted per CLAUDE.md §15 so the cooldown and A/B-variant selection are
 * unit-testable without React (tests/unit/gate-logic.test.mjs, tsx batch).
 *
 * Four concerns live here:
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
 *     was eligible for the gate the instant the dwell timer elapsed). Ran as
 *     the 'gate-cold-start' A/B (2026-07-21 to 2026-09-15), concluded in
 *     favor of making this the permanent default — see
 *     docs/experiments/gate-cold-start.md "Conclusion".
 *  4. Trigger kinds (BRO-4623 P1-15) — which triggers can be dismissed and
 *     which are exempt from the passive checks. The CSV/JSON download modal
 *     used to be a blocking wall with no close control, for a feature that
 *     does not exist yet; it is now a closable waitlist ask.
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
 * stay quiet. User-initiated gates (csv/json download) are exempt — they
 * answer an action the user just clicked, not an unsolicited ask.
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
// Trigger copy — pulled out of EmailCaptureModal.tsx (task #586, 2026-08-10)
// so the value-prop text is unit-testable per CLAUDE.md §15 without importing
// the 'use client' component tree (React/Next.js/Formspree) into a node test.
// ─────────────────────────────────────────────────────────────────────────────

export type GateTrigger =
  | 'csv_download'
  | 'json_download'
  | 'page_view_limit'
  | 'exit_intent'
  | 'scroll_depth'
  | 'return_visitor'
  | 'recapture';

// ─────────────────────────────────────────────────────────────────────────────
// Trigger kinds (BRO-4623 P1-15). Two separate properties that used to be
// conflated in ProGateContext's single BLOCKING_TRIGGERS list:
//   - blocking: the modal has no close control, no Escape, no backdrop close.
//   - user-initiated: the user clicked something that opened the modal, so the
//     passive checks (cold-start page minimum, dismissal cooldown) do not apply
//     and dismissing it does not start the passive cooldown.
// CSV/JSON downloads are user-initiated but NOT blocking: the feature does not
// exist yet, so the modal must never trap the visitor.
// ─────────────────────────────────────────────────────────────────────────────

/** Triggers whose modal cannot be dismissed. */
export const BLOCKING_TRIGGERS: readonly GateTrigger[] = ['page_view_limit'];

/** Triggers opened by an explicit click; exempt from the passive checks. */
export const USER_INITIATED_TRIGGERS: readonly GateTrigger[] = ['csv_download', 'json_download'];

export function isBlockingTrigger(trigger: GateTrigger): boolean {
  return BLOCKING_TRIGGERS.includes(trigger);
}

export function isUserInitiatedTrigger(trigger: GateTrigger): boolean {
  return USER_INITIATED_TRIGGERS.includes(trigger);
}

/**
 * True when the cold-start page minimum and the dismissal cooldown apply.
 * Blocking and user-initiated triggers are exempt; recapture is already
 * one-shot via RECAPTURED_KEY in ProGateContext.
 */
export function isPassiveTrigger(trigger: GateTrigger): boolean {
  return !isBlockingTrigger(trigger) && !isUserInitiatedTrigger(trigger) && trigger !== 'recapture';
}

/**
 * True when dismissing this trigger's modal should stamp the passive-gate
 * cooldown. Every non-blocking trigger did before BRO-4623; the new closable
 * CSV/JSON waitlist ask does not, so closing it on /biz cannot quiet the
 * exit-intent or scroll asks on other pages.
 */
export function dismissStartsCooldown(trigger: GateTrigger): boolean {
  return !isBlockingTrigger(trigger) && !isUserInitiatedTrigger(trigger);
}

export interface TriggerCopy {
  heading: string;
  subheading: string;
  /** Optional one-line preview of the actual email content — makes the abstract
   *  value-prop concrete. Only exit_intent/scroll_depth carry one (task #1205). */
  example?: string;
}

/**
 * Value-prop copy shown per gate trigger. exit_intent/scroll_depth were
 * rewritten 2026-08-10 (task #586, 0.6% conversion / 68% dismiss audit) from
 * the vague "Know the score before you book" to state the concrete
 * deliverable, cadence, and volume up front — the prior copy named no
 * specific benefit a visitor could weigh against handing over their email.
 * The `example` line (task #1205, gpt-5.4-mini fresh-eyes review on that same
 * session) illustrates the CriticScore format described in the subheading
 * above — it is explicitly labeled "Sample" (not "Example:", and no quotation
 * marks around the tagline) so it doesn't read as a live score or a real
 * critic's quote (ship-check 2026-08-10 caught both misreadings: gpt-5.4-mini
 * flagged the quote marks as looking like an attributed critic quote; Codex
 * flagged that the shipped opening-night email is a full score badge + review
 * count + distribution + optional Critics' Take, not this compact line —
 * this is a stylized preview of the deliverable, not a literal rendering).
 * EXAMPLE_SCORE values are asserted against the live canonical score in
 * tests/unit/email-gate-conversion.test.mjs so a Hamilton rescore fails CI
 * instead of shipping a silently stale number.
 *
 * csv_download/json_download (BRO-4623 P1-15): the old copy ("CSV Export
 * Coming Soon" / "API Access Coming Soon", "Be first to access Pro
 * features...") implied a Pro tier and an API that do not exist. The copy now
 * says plainly that downloads are not available yet and that the form is a
 * waitlist.
 */
const EXAMPLE_SCORE = { broadway: 92, westEnd: 90 }; // hamilton-2015 cs:91.83, hamilton-west-end-2021 cs:90.07 — kept in sync by the test above

const DOWNLOAD_WAITLIST_COPY: TriggerCopy = {
  heading: 'Data downloads are coming soon',
  subheading: 'CSV and JSON exports are not available yet. Join the waitlist and we will email you when they launch.',
};

/**
 * Stamped as `copyVersion` on gate_modal_shown / email_captured /
 * gate_modal_dismissed (task #1206) so the #586 copy rewrite's before/after
 * effect on conversion/dismiss can be isolated from ordinary week-to-week
 * trend — the 2026-08-24 recheck needs this to tell "copy change moved it"
 * apart from "traffic mix moved it". Bump this string (new date suffix) on
 * any future getTriggerCopy rewrite so old and new copy segment cleanly in
 * scripts/analyze-email-gate-funnel.js's byCopyVersion breakdown.
 *
 * v3-2026-10-04 (BRO-4623): only csv_download/json_download copy changed (and
 * those modals became closable). exit_intent/scroll_depth/return_visitor copy
 * is identical to v2, so v2 and v3 rows can be pooled for those triggers.
 * v4-2026-10-08 (BRO-4893): exit_intent/scroll_depth dropped "Nothing else."
 * for "plus a short Sunday roundup" (subscribers get the Sunday newsletter).
 * Do not pool v4 with earlier rows for those two triggers.
 */
export const COPY_VERSION = 'v4-2026-10-08';

export function getTriggerCopy(trigger: GateTrigger, isWE: boolean): TriggerCopy {
  const market = isWE ? 'West End' : 'Broadway';
  const exampleScore = isWE ? EXAMPLE_SCORE.westEnd : EXAMPLE_SCORE.broadway;
  const copies: Record<GateTrigger, TriggerCopy> = {
    csv_download: { ...DOWNLOAD_WAITLIST_COPY },
    json_download: { ...DOWNLOAD_WAITLIST_COPY },
    page_view_limit: {
      heading: 'Want to see more?',
      subheading: `Enter your email for full access to ${market} investment data.`,
    },
    exit_intent: {
      heading: `Before you go: the ${market} CriticScore`,
      subheading: 'One email per opening night with the CriticScore and a one-line critics’ verdict, plus a short Sunday roundup.',
      example: `Sample: Hamilton — ${exampleScore} · Sharp, electric, essential.`,
    },
    scroll_depth: {
      heading: `Before you go: the ${market} CriticScore`,
      subheading: 'One email per opening night with the CriticScore and a one-line critics’ verdict, plus a short Sunday roundup.',
      example: `Sample: Hamilton — ${exampleScore} · Sharp, electric, essential.`,
    },
    return_visitor: {
      heading: `Never miss a new ${market} show`,
      subheading: isWE
        ? 'We’ll email you when new West End shows get their reviews, plus what’s closing soon.'
        : 'We’ll email you the CriticScore when new shows open, plus what’s closing soon.',
    },
    recapture: {
      heading: 'Confirm your email',
      subheading: 'We updated how we send opening night scores. Enter your email once more to stay on the list.',
    },
  };
  return copies[trigger];
}

/** Submit-button label for the capture modal (BRO-4623 P1-15). */
export function getSubmitLabel(trigger: GateTrigger): string {
  if (isUserInitiatedTrigger(trigger)) return 'Join the waitlist';
  if (trigger === 'page_view_limit') return 'Get Early Access';
  return 'Send me opening night scores';
}
