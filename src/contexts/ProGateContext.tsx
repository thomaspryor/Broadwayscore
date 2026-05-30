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

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { track } from '@vercel/analytics';
import { captureEvent } from '@/lib/posthog-events';
import { type GateTrigger, type CapturedUserData } from '@/components/EmailCaptureModal';
import { emailCaptureConfig } from '@/config/email-capture';
import { isFormspreeSubscribed } from '@/hooks/useFormspreeSubscribed';
import { isLondonPath } from '@/hooks/useCurrentMarket';

const EmailCaptureModal = dynamic(() => import('@/components/EmailCaptureModal'), { ssr: false });

const STORAGE_KEY = 'bsc_user_data';
const PAGE_VIEW_KEY = 'bsc_page_views';
const LAST_VISIT_KEY = 'bsc_last_visit';
const RECAPTURED_KEY = 'bsc_email_recaptured'; // Pre-fix modal submissions (Jan 29 – Mar 12, 2026) stored email locally only

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
  const [isReturnVisitor, setIsReturnVisitor] = useState(false);
  const [isClient, setIsClient] = useState(false);
  // Recapture: true when pre-fix modal user needs to be re-shown the modal to capture via Formspree
  const [needsRecapture, setNeedsRecapture] = useState(false);

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

  const triggerGate = useCallback((trigger: GateTrigger) => {
    if (hasEmail) return; // Don't show if already have email
    if (modalOpen) return; // Don't stack modals
    // Don't trigger on excluded pages (feedback, submit-review, etc.)
    if (emailCaptureConfig.excludedPaths.some(p => window.location.pathname.startsWith(p))) return;
    setModalTrigger(trigger);
    setModalBlocking(BLOCKING_TRIGGERS.includes(trigger));
    setModalOpen(true);
  }, [hasEmail, modalOpen]);

  const handleModalClose = useCallback(() => {
    if (modalBlocking) return; // Can't close blocking modals
    track('gate_modal_dismissed', { trigger: modalTrigger });
    captureEvent('gate_modal_dismissed', { trigger: modalTrigger });
    setModalOpen(false);
  }, [modalBlocking, modalTrigger]);

  // Recapture: fire non-blocking modal after 4s for pre-fix users who need re-submission to Formspree
  useEffect(() => {
    if (!needsRecapture || !isClient) return;
    const timer = setTimeout(() => {
      setModalTrigger('recapture');
      setModalBlocking(false);
      setModalOpen(true);
      setNeedsRecapture(false);
    }, 4000);
    return () => clearTimeout(timer);
  }, [needsRecapture, isClient]);

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
      // Only trigger when mouse leaves through the top of the viewport
      if (e.clientY <= 0 && !modalOpen) {
        setExitIntentFired(true);
        setPassiveModalFired(true);
        triggerGate(isReturnVisitor ? 'return_visitor' : 'exit_intent');
      }
    };

    document.addEventListener('mouseleave', handleMouseLeave);
    return () => document.removeEventListener('mouseleave', handleMouseLeave);
  }, [isClient, hasEmail, exitIntentFired, passiveModalFired, isReturnVisitor, modalOpen, triggerGate]);

  // Mobile scroll-depth detection — replaces exit intent for touch devices
  const [scrollFired, setScrollFired] = useState(false);
  useEffect(() => {
    const config = emailCaptureConfig.mobileScrollGate;
    if (!config.enabled) return;
    if (!isClient || hasEmail || scrollFired || passiveModalFired) return;

    // Only fire on touch devices (no fine pointer = mobile/tablet)
    const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
    if (!isTouchDevice) return;

    const pageLoadTime = Date.now();
    let fired = false;

    const handleScroll = () => {
      if (fired || modalOpen) return;

      // Check time-on-page requirement
      const elapsedSec = (Date.now() - pageLoadTime) / 1000;
      if (elapsedSec < config.minTimeOnPageSec) return;

      // Check scroll depth
      const scrollTop = window.scrollY || document.documentElement.scrollTop;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      if (docHeight <= 0) return;
      const scrollPct = scrollTop / docHeight;

      if (scrollPct >= config.scrollThreshold) {
        fired = true;
        setScrollFired(true);
        setPassiveModalFired(true);
        triggerGate(isReturnVisitor ? 'return_visitor' : 'scroll_depth');
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [isClient, hasEmail, scrollFired, passiveModalFired, isReturnVisitor, modalOpen, triggerGate]);

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

      // Check if should show gate (skip if already shown a passive modal this session)
      const totalViews = Object.values(views).reduce((sum: number, v) => sum + (v as number), 0);
      if (totalViews >= pageViewThreshold && !hasEmail && !passiveModalFired) {
        // Show gate after short delay to let page render
        setPassiveModalFired(true);
        setTimeout(() => triggerGate('page_view_limit'), 2000);
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
