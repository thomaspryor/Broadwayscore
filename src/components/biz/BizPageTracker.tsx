'use client';

/**
 * BizPageTracker - Tracks page views on biz pages for gating purposes
 * Phase 0: Monetization optionality
 */

import { useEffect } from 'react';
import { useProGate } from '@/contexts/ProGateContext';

interface BizPageTrackerProps {
  page: string;
}

export default function BizPageTracker({ page }: BizPageTrackerProps) {
  const { recordPageView } = useProGate();

  useEffect(() => {
    recordPageView(page);
  }, [page, recordPageView]);

  return null;
}
