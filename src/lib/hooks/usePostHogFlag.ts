'use client';

import { useEffect, useState } from 'react';

/**
 * Resolve a PostHog feature flag on the client. Polls
 * `window.posthog.getFeatureFlag(key)` every 250ms, up to 20 tries (5s), and
 * returns `undefined` until it resolves to a string variant (or forever, when
 * PostHog is blocked or the flag never resolves). Callers must treat
 * `undefined` as the safe default.
 *
 * Shared by TicketButtonsAB.tsx and ProGateContext.tsx, among others.
 * The flag-registry scanner (scripts/lib/flag-registry.js)
 * reads `usePostHogFlag(...)` call sites, so pass a literal or an exported
 * UPPER_SNAKE constant.
 *
 * `enabled: false` skips the read entirely. Every getFeatureFlag call records
 * an exposure (`$feature_flag_called`, `$feature/<key>`), so gate on
 * eligibility first to keep ineligible visitors out of the experiment.
 */
export function usePostHogFlag(key: string, enabled = true): string | undefined {
  const [value, setValue] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    let attempts = 0;
    const maxAttempts = 20; // 20 × 250ms = 5 seconds total
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let done = false;

    const check = () => {
      const flag = window.posthog?.getFeatureFlag?.(key);
      if (typeof flag === 'string') {
        done = true;
        setValue(flag);
        if (intervalId) clearInterval(intervalId);
        return;
      }
      attempts++;
      if (attempts >= maxAttempts && intervalId) clearInterval(intervalId);
    };

    check();
    if (!done) intervalId = setInterval(check, 250);

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [key, enabled]);

  return enabled ? value : undefined;
}
