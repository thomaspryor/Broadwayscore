'use client';

/**
 * BizPageTracker - Tracks page views on biz pages for gating purposes
 * Phase 0: Monetization optionality
 *
 * `gate={false}` counts and tracks the view but never schedules the blocking
 * page_view_limit modal (BRO-4623 P1-15: /biz passes false).
 */

import { useEffect } from 'react';
import { useProGate } from '@/contexts/ProGateContext';

interface BizPageTrackerProps {
  page: string;
  /** When false, never schedules the page_view_limit modal. Defaults to true. */
  gate?: boolean;
}

export default function BizPageTracker({ page, gate = true }: BizPageTrackerProps) {
  const { recordPageView } = useProGate();

  useEffect(() => {
    recordPageView(page, { gate });
  }, [page, gate, recordPageView]);

  return null;
}
