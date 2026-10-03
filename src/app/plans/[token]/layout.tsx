import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import PlansLeaveByDocument from '@/components/PlansLeaveByDocument';

// Segment-level, so the not-found and error states get it too: without it the
// "not shared" 404 rendered the root layout's index/follow robots tag and no
// referrer policy (prod check, 2026-10-03). page.tsx keeps its own copy.
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: 'no-referrer' };

// Wraps the plans page AND its error / not-found states, so every way out of a
// /plans/<token> URL is a document load (token privacy, BRO-4481).
export default function PlansLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PlansLeaveByDocument />
      {children}
    </>
  );
}
