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
}

const presets: Record<string, EmailCaptureConfig> = {
  soft: {
    excludedPaths: ['/feedback', '/submit-review', '/methodology', '/beat-the-critics'],
    exitIntent: { enabled: false },
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
  },
  aggressive: {
    excludedPaths: ['/feedback', '/submit-review', '/beat-the-critics'],
    exitIntent: { enabled: true },
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
  },
};

// ──────────────────────────────────────────
// Change this to 'aggressive' when ready
// ──────────────────────────────────────────
const ACTIVE_PRESET = 'aggressive';

export const emailCaptureConfig: EmailCaptureConfig = presets[ACTIVE_PRESET];
