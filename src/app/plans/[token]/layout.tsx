import type { ReactNode } from 'react';
import PlansLeaveByDocument from '@/components/PlansLeaveByDocument';

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
