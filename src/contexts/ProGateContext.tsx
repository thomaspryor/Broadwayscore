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
import { track } from '@vercel/analytics';
import EmailCaptureModal, { type GateTrigger, type CapturedUserData } from '@/components/EmailCaptureModal';

const STORAGE_KEY = 'bsc_user_data';
const PAGE_VIEW_KEY = 'bsc_page_views';
const LAST_VISIT_KEY = 'bsc_last_visit';

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

export function ProGateProvider({ children, pageViewThreshold = 2 }: ProGateProviderProps) {
  const [hasEmail, setHasEmail] = useState(false);
  const [userData, setUserData] = useState<CapturedUserData | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTrigger, setModalTrigger] = useState<GateTrigger>('page_view_limit');
  const [modalBlocking, setModalBlocking] = useState(false);
  const [exitIntentFired, setExitIntentFired] = useState(false);
  const [isClient, setIsClient] = useState(false);

  // Load saved user data on mount
  useEffect(() => {
    setIsClient(true);
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as CapturedUserData;
        setUserData(parsed);
        setHasEmail(true);
      }

      // Check if return visitor
      const lastVisit = localStorage.getItem(LAST_VISIT_KEY);
      const now = Date.now();
      if (lastVisit) {
        const daysSinceVisit = (now - parseInt(lastVisit, 10)) / (1000 * 60 * 60 * 24);
        // If they visited more than 1 day ago but don't have email, consider return visitor
        if (daysSinceVisit > 1 && !saved) {
          // Could trigger return visitor gate here
        }
      }
      localStorage.setItem(LAST_VISIT_KEY, String(now));
    } catch {
      // localStorage not available
    }
  }, []);

  const triggerGate = useCallback((trigger: GateTrigger) => {
    if (hasEmail) return; // Don't show if already have email
    if (modalOpen) return; // Don't stack modals
    setModalTrigger(trigger);
    setModalBlocking(BLOCKING_TRIGGERS.includes(trigger));
    setModalOpen(true);
  }, [hasEmail, modalOpen]);

  const handleModalClose = useCallback(() => {
    if (modalBlocking) return; // Can't close blocking modals
    setModalOpen(false);
  }, [modalBlocking]);

  // Exit intent detection - fires when mouse leaves viewport toward top
  useEffect(() => {
    if (!isClient || hasEmail || exitIntentFired) return;

    const handleMouseLeave = (e: MouseEvent) => {
      // Only trigger when mouse leaves through the top of the viewport
      if (e.clientY <= 0 && !modalOpen) {
        setExitIntentFired(true);
        triggerGate('exit_intent');
      }
    };

    document.addEventListener('mouseleave', handleMouseLeave);
    return () => document.removeEventListener('mouseleave', handleMouseLeave);
  }, [isClient, hasEmail, exitIntentFired, modalOpen, triggerGate]);

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

    // TODO: In future, also send to backend/Formspree/etc.
    console.log('Email captured:', data);
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

      // Check if should show gate
      const totalViews = Object.values(views).reduce((sum: number, v) => sum + (v as number), 0);
      if (totalViews >= pageViewThreshold && !hasEmail) {
        // Show gate after short delay to let page render
        setTimeout(() => triggerGate('page_view_limit'), 2000);
      }
    } catch {
      // localStorage not available
    }
  }, [isClient, pageViewThreshold, hasEmail, triggerGate]);

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
