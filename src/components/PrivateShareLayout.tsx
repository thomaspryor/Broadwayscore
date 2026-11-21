import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import LeaveByDocument from '@/components/LeaveByDocument';

/**
 * Shell for every private share route (/plans/<token>, /seen/<token>;
 * BRO-4481, BRO-4566). Each route's layout.tsx re-exports both pieces, so
 * the page AND its error / not-found states get them:
 *  - robots noindex/nofollow + no-referrer. Segment-level on purpose: page
 *    metadata doesn't reach the not-found boundary, which otherwise rendered
 *    the root layout's index/follow tag (prod check, 2026-10-03).
 *  - every way out is a document load (src/lib/analytics/leave-by-document.ts),
 *    so GA never sees the token as a client-side page_referrer.
 * Add the route's prefix to PRIVATE_SHARE_PREFIXES too (redact-url.ts).
 */
export const privateShareMetadata: Metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default function PrivateShareLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <LeaveByDocument />
      {children}
    </>
  );
}
