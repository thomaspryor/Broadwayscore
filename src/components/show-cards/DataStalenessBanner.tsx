'use client';

import { useEffect, useState } from 'react';
import { staleDaysFor, stalenessMessage, type StalenessKind } from '@/lib/data-staleness';

export interface DataStalenessBannerProps {
  /** ISO timestamp the feed was last refreshed (e.g. lottery-rush.json lastUpdated). */
  lastUpdated: string | null | undefined;
  /** Which feed, for the copy and the default threshold. */
  kind?: StalenessKind;
  /** kind="grosses" only: grosses.json weekEnding (M/D/YYYY). Age is measured
   *  from the week the figures cover, not just the last scrape. */
  weekEnding?: string | null;
  /** Override the per-kind default threshold (days). */
  thresholdDays?: number;
  /** Market of the page. Kept for parity with the page props; copy is market-neutral. */
  market?: 'broadway' | 'west-end';
}

/**
 * Amber "this data may be out of date" banner for the ticket-discovery pages
 * (BRO-901). Not dismissible on purpose: a dismissed staleness warning is an
 * invisible one.
 *
 * Decided in the browser only, after mount. The site is statically exported,
 * so a server-side verdict would be the age at build time: a page served long
 * after its last build would never warn, and seeding state with the viewer's
 * clock instead makes the first client render disagree with the static HTML
 * (hydration mismatch) exactly when the warning matters.
 */
export function DataStalenessBanner({ lastUpdated, kind = 'ticket-policies', weekEnding, thresholdDays }: DataStalenessBannerProps) {
  const [days, setDays] = useState<number | null>(null);

  useEffect(() => {
    setDays(staleDaysFor({ kind, lastUpdated, weekEnding, thresholdDays }));
  }, [kind, lastUpdated, weekEnding, thresholdDays]);

  if (days === null) return null;

  return (
    <div
      role="status"
      data-testid="data-staleness-banner"
      className="mb-6 flex items-start gap-2.5 rounded-lg border border-score-tepid/40 bg-score-tepid-bg px-4 py-3 text-sm text-score-tepid"
    >
      <svg className="mt-0.5 h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      </svg>
      <p>{stalenessMessage(days, kind)}</p>
    </div>
  );
}

export default DataStalenessBanner;
