'use client';

/**
 * ProGateContext - Context for managing email capture gate state
 * Phase 0: Monetization optionality
 *
 * Tracks:
 * - Whether user has submitted email
 * - Page view counts for gating
 * - Provides methods to trigger gate modal
 */

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { track } from '@vercel/analytics';
import { captureEvent } from '@/lib/posthog-events';
import { type GateTrigger, type CapturedUserData } from '@/components/EmailCaptureModal';
import { emailCaptureConfig } from '@/config/email-capture';
import {
  shouldSuppressPassiveGate,
  hasSeenEnoughPages,
  getColdStartArm,
  coldStartCheckApplies,
  COLD_START_FLAG,
  getMobileGateParams,
  buildGateAbVariant,
  MOBILE_GATE_FLAG,
} from '@/lib/gate-logic';
import { isFormspreeSubscribed } from '@/hooks/useFormspreeSubscribed';
import { isLondonPath } from '@/hooks/useCurrentMarket';
import { useAuth } from '@/contexts/AuthContext';

const EmailCaptureModal = dynamic(() => import('@/components/EmailCaptureModal'), { ssr: false });

const STORAGE_KEY = 'bsc_user_data';
const PAGE_VIEW_KEY = 'bsc_page_views';
const LAST_VISIT_KEY = 'bsc_last_visit';
const RECAPTURED_KEY = 'bsc_email_recaptured'; // Pre-fix modal submissions (Jan 29 – Mar 12, 2026) stored email locally only
// Passive-gate dismissal cooldown stamp (ms epoch). Written on dismiss of any
// NON-blocking modal; read before firing any non-blocking trigger. Without it,
// dismissal was React-state only and the same visitor was re-gated every visit
// (2,992 exit-intent impressions / 2,150 people, 87% mobile dismissal — 2026-07 audit).
const GATE_DISMISSED_KEY = 'bsc_gate_dismissed_at';
// Session-scoped page-view counter (sessionStorage — resets per tab), read by
// triggerGate to hold off any passive gate until the visitor has shown real
// engagement (emailCaptureConfig.minPageViewsForPassiveGate). See gate-logic.ts.
const SESSION_PAGEVIEWS_KEY = 'bsc_session_pageviews';

/** Extra analytics props stamped at fire time (A/B variant + demixed source). */
type GateFireMeta = { trigger_source?: string; ab_variant?: string; ab_cold_start?: string };

interface ProGateContextValue {
  /** Whether the user has submitted their email */
  hasEmail: boolean;
  /** The captured user data (if any) */
  userData: CapturedUserData | null;
  /** Trigger the email capture modal */
  triggerGate: (trigger: GateTrigger) => void;
  /** Check if the gate should be shown (based on page views, etc.) */
  shouldShowGate: () => boolean;
  /** Record a page view and potentially trigger gate */
  recordPageView: (page: string) => void;
  /** Track a blocked action (e.g., CSV download attempt) */
  trackBlockedAction: (action: string) => void;
}

const ProGateContext = createContext<ProGateContextValue | null>(null);

interface ProGateProviderProps {
  children: ReactNode;
  /** Number of page views before showing gate (default: 3) */
  pageViewThreshold?: number;
}

// Triggers that block the user from dismissing the modal
const BLOCKING_TRIGGERS: GateTrigger[] = ['csv_download', 'json_download', 'page_view_limit'];

export function ProGateProvider({ children, pageViewThreshold = emailCaptureConfig.pageViewGate.threshold }: ProGateProviderProps) {
  // Email capture is per-market. A visitor subscribed to Broadway must still be
  // offered the West End list when browsing /west-end (and vice versa) — otherwise
  // the dominant market's subscribers permanently suppress the other market's
  // pop-up. `market` drives both the hasEmail gate (below) and the modal's own
  // form routing (EmailCaptureModal computes the same isLondonPath check).
  const pathname = usePathname();
  const market = pathname && isLondonPath(pathname) ? 'west-end' : 'broadway';

  // Signed-in users NEVER see capture pop-ups: sign-in auto-subscribes them to
  // the main list (src/lib/auto-subscribe.ts), and this gate also covers new
  // devices where localStorage has no subscribed flag yet (owner, 2026-07-13).
  // Safe when the userAccounts flag is off — useAuth falls back to
  // isAuthenticated:false defaults outside an AuthProvider.
  const { isAuthenticated } = useAuth();

  // Initialize hasEmail synchronously from the CURRENT market's subscription, so an
  // already-subscribed user is never transiently treated as hasEmail=false on the
  // first render — that window could fire a page-view nag before the [market]
  // effect below commits. SSR-safe: isFormspreeSubscribed try/catches localStorage
  // and returns false on the server (the gated modal is ssr:false anyway).
  const [hasEmail, setHasEmail] = useState(() => isFormspreeSubscribed(market));
  const [userData, setUserData] = useState<CapturedUserData | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTrigger, setModalTrigger] = useState<GateTrigger>('page_view_limit');
  const [modalBlocking, setModalBlocking] = useState(false);
  const [exitIntentFired, setExitIntentFired] = useState(false);
  // Track whether ANY passive modal (exit intent, scroll depth, page view limit) has fired this session
  const [passiveModalFired, setPassiveModalFired] = useState(false);
  // Guards against scheduling more than one delayed page_view_limit attempt —
  // separate from passiveModalFired so a suppressed attempt (see recordPageView)
  // doesn't falsely latch the shared "a passive modal fired" flag.
  const pageViewLimitScheduledRef = useRef<boolean>(false);
  const [isReturnVisitor, setIsReturnVisitor] = useState(false);
  const [isClient, setIsClient] = useState(false);
  // Recapture: true when pre-fix modal user needs to be re-shown the modal to capture via Formspree
  const [needsRecapture, setNeedsRecapture] = useState(false);
  // Per-PAGE dwell clock for the exit-intent gate — resets on every pathname
  // change, unlike the mobile-timing effect's mountTimeRef below (that one is
  // intentionally session-lifetime-scoped and belongs to the live
  // mobile-gate-timing A/B test; left untouched here to avoid disturbing its
  // exposure conditions). A provider-lifetime clock would let a visitor who's
  // dwelled 5s+ anywhere in the session arm exit-intent instantly on every new
  // page thereafter — same "reflexive fire" bug this gate exists to prevent,
  // just deferred to the second page instead of the first (2026-07-14 review).
  const exitIntentPageMountRef = useRef<number>(0);
  useEffect(() => {
    exitIntentPageMountRef.current = Date.now();
  }, [pathname]);

  // Session page-view counter — increments on every pathname change (incl.
  // first mount), persisted to sessionStorage so it survives SPA navigation.
  // Read (not depended-on) inside triggerGate, same pattern as the ref above.
  const sessionPageViewsRef = useRef<number>(0);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(SESSION_PAGEVIEWS_KEY);
      const next = (raw ? parseInt(raw, 10) || 0 : 0) + 1;
      sessionStorage.setItem(SESSION_PAGEVIEWS_KEY, String(next));
      sessionPageViewsRef.current = next;
    } catch {
      // sessionStorage unavailable (private mode) — fail open with a
      // per-mount-only count so the gate isn't permanently silenced.
      sessionPageViewsRef.current += 1;
    }
  }, [pathname]);

  // ── gate-cold-start A/B flag resolution (all devices) ──────────────────────
  // ⚠️ LIVE EXPERIMENT — see docs/experiments/gate-cold-start.md before
  // editing. Resolves the arm once per provider mount (sticky per-visitor via
  // PostHog's distinct_id hash). Same poll-then-fallback shape as the
  // mobile-timing flag below: 250ms x 20; unresolved after 5s → null, which
  // getColdStartArm maps to 'fallback' (control BEHAVIOR, excluded from
  // analysis). Stored in a REF because triggerGate reads it outside its
  // dependency array (same pattern as sessionPageViewsRef above).
  const coldStartFlagRef = useRef<string | boolean | null | undefined>(undefined);
  useEffect(() => {
    if (!isClient) return;
    let tries = 0;
    const poll = setInterval(() => {
      tries++;
      const ph = window.posthog;
      const value = ph?.getFeatureFlag?.(COLD_START_FLAG);
      if (typeof value === 'string' || value === true) {
        coldStartFlagRef.current = value;
        clearInterval(poll);
      } else if (tries >= 20) {
        coldStartFlagRef.current = null; // ad blocker / opt-out / flag missing → fallback
        clearInterval(poll);
      }
    }, 250);
    return () => clearInterval(poll);
  }, [isClient]);

  // Load saved user data on mount
  useEffect(() => {
    setIsClient(true);
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      const formspreeSubscribed = isFormspreeSubscribed();

      // NOTE: hasEmail is derived per-market in the dedicated effect below — do NOT
      // set it globally here, or a subscriber to one market is treated as subscribed
      // everywhere and never sees the other market's pop-up.
      if (saved) {
        const parsed = JSON.parse(saved) as CapturedUserData;
        setUserData(parsed);

        // Recapture: user submitted via the broken pre-fix modal (Jan 29 – Mar 12, 2026).
        // Their email was only saved to localStorage, not sent to Formspree.
        // Re-show the modal non-blockingly once so we can capture it properly.
        if (!formspreeSubscribed && localStorage.getItem(RECAPTURED_KEY) !== 'true') {
          localStorage.setItem(RECAPTURED_KEY, 'true'); // Only attempt once
          setNeedsRecapture(true);
        }
      }

      // Check if return visitor (visited 1+ days ago, no email)
      const lastVisit = localStorage.getItem(LAST_VISIT_KEY);
      const now = Date.now();
      if (lastVisit) {
        const daysSinceVisit = (now - parseInt(lastVisit, 10)) / (1000 * 60 * 60 * 24);
        if (daysSinceVisit > 1 && !saved && !formspreeSubscribed) {
          setIsReturnVisitor(true);
        }
      }
      localStorage.setItem(LAST_VISIT_KEY, String(now));
    } catch {
      // localStorage not available
    }
  }, []);

  // Derive hasEmail from the CURRENT market's subscription state. Re-runs on
  // navigation between markets so a Broadway-only subscriber who lands on a
  // /west-end page is still gated as "no email" and gets the WE pop-up.
  useEffect(() => {
    if (!isClient) return;
    setHasEmail(isFormspreeSubscribed(market));
  }, [market, isClient]);

  // Analytics props stamped when the current modal fired (variant + source) —
  // merged into gate_modal_shown / gate_modal_dismissed / email_captured so the
  // A/B analysis can attribute every event to an arm and demix the
  // return_visitor trigger name (which both the scroll and mouseleave paths reuse).
  const [gateFireMeta, setGateFireMeta] = useState<GateFireMeta>({});

  // Returns whether the modal actually opened. Callers MUST gate their own
  // "already fired this session" latches (exitIntentFired, scrollFired,
  // passiveModalFired) on this return value — setting them unconditionally
  // before calling triggerGate would permanently disarm the trigger for the
  // rest of the tab session on every early return below (cooldown, cold-start
  // page-count gate, excluded path, etc.), even though no modal was ever
  // shown (2026-07-20 review: caught before ship — see call sites).
  const triggerGate = useCallback((trigger: GateTrigger, meta: GateFireMeta = {}): boolean => {
    if (isAuthenticated) return false; // Signed-in users are auto-subscribed — never nag
    if (hasEmail) return false; // Don't show if already have email
    if (modalOpen) return false; // Don't stack modals
    // Don't trigger on excluded pages (feedback, submit-review, etc.)
    if (emailCaptureConfig.excludedPaths.some(p => window.location.pathname.startsWith(p))) return false;
    const blocking = BLOCKING_TRIGGERS.includes(trigger);
    // ⚠️ LIVE EXPERIMENT 'gate-cold-start' (docs/experiments/gate-cold-start.md):
    // the cold-start page-minimum below applies ONLY to the 'cold-start' arm;
    // 'control' and 'fallback' reproduce the pre-2026-07-20 behavior (no
    // minimum). Both arms share the dismissal cooldown (it predates the
    // experiment and is part of the baseline in both arms). Do not change
    // either branch mid-experiment — locked by tests/unit/gate-logic.test.mjs.
    const coldStartArm = getColdStartArm(coldStartFlagRef.current);
    // Dismissal cooldown: every non-blocking ask (exit_intent, scroll_depth,
    // return_visitor, page_view_limit) stays quiet for passiveGateCooldownDays
    // after a dismissal. Blocking feature gates are exempt (user clicked the
    // gated action); recapture is already one-shot via RECAPTURED_KEY.
    if (!blocking && trigger !== 'recapture') {
      // Cold-start guard (treatment arm only): don't ask before the visitor
      // has shown real engagement this session (2026-07-20 audit — see
      // gate-logic.ts).
      if (coldStartCheckApplies(coldStartArm)
        && !hasSeenEnoughPages(sessionPageViewsRef.current, emailCaptureConfig.minPageViewsForPassiveGate)) {
        return false;
      }
      try {
        if (shouldSuppressPassiveGate(
          localStorage.getItem(GATE_DISMISSED_KEY),
          Date.now(),
          emailCaptureConfig.passiveGateCooldownDays,
        )) return false;
      } catch { /* localStorage unavailable — fail open, show the modal */ }
    }
    // Stamp the arm on every fired modal's events (shown/dismissed/captured)
    // so the analyzer can attribute — blocking triggers included, they exist
    // in both arms identically and get 'fallback'/arm labels for free.
    setGateFireMeta({ ...meta, ab_cold_start: coldStartArm });
    setModalTrigger(trigger);
    setModalBlocking(blocking);
    setModalOpen(true);
    return true;
  }, [isAuthenticated, hasEmail, modalOpen]);

  const handleModalClose = useCallback(() => {
    if (modalBlocking) return; // Can't close blocking modals
    // Close FIRST — nothing below may keep the modal stuck open (Safari
    // Lockdown/private mode can throw on localStorage.setItem).
    setModalOpen(false);
    try {
      localStorage.setItem(GATE_DISMISSED_KEY, String(Date.now()));
    } catch { /* localStorage unavailable — cooldown just won't persist */ }
    track('gate_modal_dismissed', { trigger: modalTrigger, ...gateFireMeta });
    captureEvent('gate_modal_dismissed', { trigger: modalTrigger, ...gateFireMeta });
  }, [modalBlocking, modalTrigger, gateFireMeta]);

  // Recapture: fire non-blocking modal after 4s for pre-fix users who need re-submission to Formspree
  useEffect(() => {
    if (!needsRecapture || !isClient || isAuthenticated) return;
    const timer = setTimeout(() => {
      setModalTrigger('recapture');
      setModalBlocking(false);
      setModalOpen(true);
      setNeedsRecapture(false);
    }, 4000);
    return () => clearTimeout(timer);
  }, [needsRecapture, isClient, isAuthenticated]);

  // Listen for mid-session subscriptions from inline forms (FooterEmailCapture, etc.)
  useEffect(() => {
    const handleSubscribed = () => {
      // Re-evaluate for the current market rather than blanket-true, so subscribing
      // to one market doesn't suppress the other market's pop-up.
      setHasEmail(isFormspreeSubscribed(market));
      setModalOpen(false);
    };
    window.addEventListener('bsc_subscribed', handleSubscribed);
    return () => window.removeEventListener('bsc_subscribed', handleSubscribed);
  }, [market]);

  // Exit intent detection - fires when mouse leaves viewport toward top (desktop only)
  useEffect(() => {
    if (!emailCaptureConfig.exitIntent.enabled) return;
    if (!isClient || hasEmail || exitIntentFired || passiveModalFired) return;

    const handleMouseLeave = (e: MouseEvent) => {
      // Only trigger when mouse leaves through the top of the viewport, and only
      // after a minimum dwell time ON THIS PAGE — without this a reflexive mouse
      // move toward the tab/address bar milliseconds after a page loads counted
      // as "exit intent" (2026-07-14 audit: exit_intent was the single largest
      // gate trigger by volume — 2,253 shown/30d — with zero dwell gate, unlike
      // scroll_depth which already required minTimeOnPageSec). Uses
      // exitIntentPageMountRef (resets per pathname), NOT the mobile-timing
      // effect's mountTimeRef below — that ref is session-lifetime-scoped
      // (ProGateProvider mounts once in the root layout) and reusing it here
      // let dwell time carry over between page navigations, arming exit-intent
      // instantly on every page after the first few seconds of a session.
      const elapsedSec = (Date.now() - exitIntentPageMountRef.current) / 1000;
      if (e.clientY <= 0 && !modalOpen && elapsedSec >= emailCaptureConfig.exitIntent.minTimeOnPageSec) {
        // Only latch "fired" on an actual open — a suppressed attempt (still
        // cold, in cooldown) must leave the listener armed to retry later.
        const opened = triggerGate(isReturnVisitor ? 'return_visitor' : 'exit_intent', { trigger_source: 'mouseleave' });
        if (opened) {
          setExitIntentFired(true);
          setPassiveModalFired(true);
        }
      }
    };

    document.addEventListener('mouseleave', handleMouseLeave);
    return () => document.removeEventListener('mouseleave', handleMouseLeave);
  }, [isClient, hasEmail, exitIntentFired, passiveModalFired, isReturnVisitor, modalOpen, triggerGate]);

  // ── Mobile gate timing A/B ('mobile-gate-timing' PostHog flag) ─────────────
  // Resolve the flag BEFORE arming the scroll listener — flags load 0.5-5s after
  // mount, and a fast scroller crossing the threshold pre-resolution would get
  // control behavior while PostHog's sticky assignment records the variant
  // (contaminated arms). Same poll-then-fallback shape as TicketButtonsAB:
  // 250ms x 20; after 5s unresolved → 'fallback' (control BEHAVIOR, but labeled
  // fallback so analysis EXCLUDES those users rather than polluting control).
  // undefined = still resolving (listener stays unarmed); string|null = resolved.
  const [mobileGateFlag, setMobileGateFlag] = useState<string | null | undefined>(undefined);
  // Time-on-page clock starts at mount, NOT at listener arming — otherwise flag
  // latency would silently extend control's min-time and bias the comparison.
  const mountTimeRef = useRef<number>(0);
  useEffect(() => {
    if (!isClient) return;
    mountTimeRef.current = Date.now();
    if (!emailCaptureConfig.mobileScrollGate.enabled) return;
    // Only resolve on touch devices — the experiment exists only there, and
    // resolving on desktop would put desktop users in PostHog's exposure cohort.
    if (!window.matchMedia('(pointer: coarse)').matches) return;

    let tries = 0;
    const poll = setInterval(() => {
      tries++;
      const ph = window.posthog; // typed via the global posthog declaration (TicketButtonsAB idiom)
      const value = ph?.getFeatureFlag?.(MOBILE_GATE_FLAG);
      if (typeof value === 'string' || value === true) {
        setMobileGateFlag(String(value));
        clearInterval(poll);
      } else if (tries >= 20) {
        setMobileGateFlag(null); // ad blocker / opt-out / flag missing → fallback
        clearInterval(poll);
      }
    }, 250);
    return () => clearInterval(poll);
  }, [isClient]);

  // Mobile scroll-depth detection — replaces exit intent for touch devices
  const [scrollFired, setScrollFired] = useState(false);
  useEffect(() => {
    if (!emailCaptureConfig.mobileScrollGate.enabled) return;
    if (!isClient || hasEmail || scrollFired || passiveModalFired) return;
    if (mobileGateFlag === undefined) return; // flag unresolved — listener stays unarmed

    // Only fire on touch devices (no fine pointer = mobile/tablet)
    const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
    if (!isTouchDevice) return;

    const params = getMobileGateParams(mobileGateFlag);
    const abVariant = buildGateAbVariant(params.timing);
    let fired = false;

    const handleScroll = () => {
      if (fired || modalOpen) return;

      // Time-on-page from MOUNT (see mountTimeRef). Both arms keep a minimum —
      // the variant's small floor guards against instant fire on back-navigation
      // scroll restoration, it is not a treatment lever.
      const elapsedSec = (Date.now() - mountTimeRef.current) / 1000;
      if (elapsedSec < params.minTimeOnPageSec) return;

      // Check scroll depth
      const scrollTop = window.scrollY || document.documentElement.scrollTop;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      if (docHeight <= 0) return;
      const scrollPct = scrollTop / docHeight;

      if (scrollPct >= params.scrollThreshold) {
        // Only latch "fired" on an actual open — a suppressed attempt (still
        // cold, in cooldown) must leave the listener armed to retry later.
        const opened = triggerGate(isReturnVisitor ? 'return_visitor' : 'scroll_depth', {
          trigger_source: 'scroll',
          ab_variant: abVariant,
        });
        if (opened) {
          fired = true;
          setScrollFired(true);
          setPassiveModalFired(true);
        }
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [isClient, hasEmail, scrollFired, passiveModalFired, isReturnVisitor, modalOpen, triggerGate, mobileGateFlag]);

  const handleModalSubmit = useCallback((data: CapturedUserData) => {
    // Save to localStorage
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // localStorage not available
    }

    setUserData(data);
    setHasEmail(true);
    setModalOpen(false);

    // Email is already captured via Formspree in the inline forms (header, footer, etc.)
    // This modal path only saves locally to gate content access
  }, []);

  const shouldShowGate = useCallback(() => {
    if (hasEmail) return false;
    if (!isClient) return false;

    try {
      const views = JSON.parse(localStorage.getItem(PAGE_VIEW_KEY) || '{}');
      const totalViews = Object.values(views).reduce((sum: number, v) => sum + (v as number), 0);
      return totalViews >= pageViewThreshold;
    } catch {
      return false;
    }
  }, [hasEmail, isClient, pageViewThreshold]);

  const recordPageView = useCallback((page: string) => {
    if (!isClient) return;

    try {
      const views = JSON.parse(localStorage.getItem(PAGE_VIEW_KEY) || '{}');
      views[page] = (views[page] || 0) + 1;
      localStorage.setItem(PAGE_VIEW_KEY, JSON.stringify(views));

      // Track in analytics
      track('biz_page_view', { page });

      // Check if should show gate (skip if already shown a passive modal this
      // session, or already scheduled a page_view_limit attempt — a ref, not
      // passiveModalFired, so a suppressed attempt doesn't wrongly disarm the
      // OTHER passive triggers' shared "already fired" latch).
      const totalViews = Object.values(views).reduce((sum: number, v) => sum + (v as number), 0);
      if (totalViews >= pageViewThreshold && !hasEmail && !passiveModalFired && !pageViewLimitScheduledRef.current) {
        pageViewLimitScheduledRef.current = true;
        // Show gate after short delay to let page render
        setTimeout(() => {
          if (triggerGate('page_view_limit', { trigger_source: 'page_views' })) {
            setPassiveModalFired(true);
          }
        }, 2000);
      }
    } catch {
      // localStorage not available
    }
  }, [isClient, pageViewThreshold, hasEmail, passiveModalFired, triggerGate]);

  const trackBlockedAction = useCallback((action: string) => {
    track('csv_click_blocked', { action, had_email: hasEmail });
  }, [hasEmail]);

  return (
    <ProGateContext.Provider
      value={{
        hasEmail,
        userData,
        triggerGate,
        shouldShowGate,
        recordPageView,
        trackBlockedAction,
      }}
    >
      {children}
      <EmailCaptureModal
        isOpen={modalOpen}
        onClose={handleModalClose}
        onSubmit={handleModalSubmit}
        trigger={modalTrigger}
        blocking={modalBlocking}
        analyticsProps={gateFireMeta}
      />
    </ProGateContext.Provider>
  );
}

export function useProGate() {
  const context = useContext(ProGateContext);
  if (!context) {
    throw new Error('useProGate must be used within a ProGateProvider');
  }
  return context;
}
