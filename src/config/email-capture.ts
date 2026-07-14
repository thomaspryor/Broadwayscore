/**
 * Email Capture Configuration
 *
 * Two presets: 'soft' (soft launch) and 'aggressive' (full engagement).
 * Switch the active preset below to change behavior site-wide.
 */

interface EmailCaptureConfig {
  /** Paths where email capture modals should never trigger */
  excludedPaths: string[];
  /** Exit intent modal (mouse leaves viewport top) */
  exitIntent: {
    enabled: boolean;
    /**
     * Minimum seconds on page before the exit-intent listener arms. Without
     * this, a reflexive mouse move toward the tab bar/address bar 100ms after
     * load counts as "exit intent" — a low-intent false positive that inflates
     * gate_modal_shown (the conversion denominator) without ever representing
     * real leave-intent (2026-07-14 audit: exit_intent was the single largest
     * trigger by volume with no dwell gate at all, unlike scroll_depth which
     * already required minTimeOnPageSec).
     */
    minTimeOnPageSec: number;
  };
  /** Page view limit gate (ProGateContext modal) */
  pageViewGate: {
    /** Number of page views before showing gate */
    threshold: number;
  };
  /** Homepage sticky banner */
  homepageBanner: {
    /** Number of visits before showing */
    visitThreshold: number;
    /** Scroll distance in px before showing */
    scrollTriggerPx: number;
    /** Days after dismiss before showing again */
    cooldownDays: number;
  };
  /** Show detail page follow banner */
  showFollowBanner: {
    /** Whether the banner is enabled at all */
    enabled: boolean;
    /** Scroll percentage (0-1) before showing */
    scrollThreshold: number;
  };
  /** Mobile scroll-depth gate (replaces exit intent on touch devices) */
  mobileScrollGate: {
    enabled: boolean;
    /** Scroll percentage (0-1) to trigger */
    scrollThreshold: number;
    /** Minimum seconds on page before triggering */
    minTimeOnPageSec: number;
  };
  /**
   * Days a passive-gate dismissal stays respected before the popup may ask
   * again (localStorage, per device). Blocking feature gates (csv/json) are
   * exempt — they gate an action the user clicked, not an unsolicited ask.
   */
  passiveGateCooldownDays: number;
  /**
   * Mobile scroll-gate timing A/B ('mobile-gate-timing' PostHog flag).
   * control = current mobileScrollGate behavior; end-of-content fires when the
   * reader reaches the bottom of the page. The variant keeps a small min-time
   * as a guard against instant fire on back-navigation scroll restoration —
   * NOT a treatment lever. Teardown after the test: pin the winner's values
   * into mobileScrollGate and delete the loser's object (keep the flag-read
   * branch — see A/B guardrails memory).
   */
  mobileScrollGateVariants: {
    control: { scrollThreshold: number; minTimeOnPageSec: number };
    'end-of-content': { scrollThreshold: number; minTimeOnPageSec: number };
  };
}

const presets: Record<string, EmailCaptureConfig> = {
  soft: {
    excludedPaths: ['/feedback', '/submit-review', '/methodology', '/beat-the-critics'],
    exitIntent: { enabled: false, minTimeOnPageSec: 8 },
    pageViewGate: { threshold: 8 },
    homepageBanner: {
      visitThreshold: 5,
      scrollTriggerPx: 400,
      cooldownDays: 90,
    },
    showFollowBanner: {
      enabled: true,
      scrollThreshold: 0.85,
    },
    mobileScrollGate: {
      enabled: false,
      scrollThreshold: 0.65,
      minTimeOnPageSec: 15,
    },
    passiveGateCooldownDays: 14,
    mobileScrollGateVariants: {
      control: { scrollThreshold: 0.65, minTimeOnPageSec: 15 },
      'end-of-content': { scrollThreshold: 0.95, minTimeOnPageSec: 3 },
    },
  },
  aggressive: {
    excludedPaths: ['/feedback', '/submit-review', '/beat-the-critics'],
    exitIntent: { enabled: true, minTimeOnPageSec: 5 },
    pageViewGate: { threshold: 2 },
    homepageBanner: {
      visitThreshold: 2,
      scrollTriggerPx: 200,
      cooldownDays: 30,
    },
    showFollowBanner: {
      enabled: true,
      scrollThreshold: 0.6,
    },
    mobileScrollGate: {
      enabled: true,
      scrollThreshold: 0.65,
      minTimeOnPageSec: 10,
    },
    passiveGateCooldownDays: 14,
    mobileScrollGateVariants: {
      control: { scrollThreshold: 0.65, minTimeOnPageSec: 10 },
      'end-of-content': { scrollThreshold: 0.95, minTimeOnPageSec: 3 },
    },
  },
};

// ──────────────────────────────────────────
// Change this to 'aggressive' when ready
// ──────────────────────────────────────────
const ACTIVE_PRESET = 'aggressive';

export const emailCaptureConfig: EmailCaptureConfig = presets[ACTIVE_PRESET];
