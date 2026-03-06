import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { featureFlags } from '@/config/feature-flags';

export const metadata: Metadata = {
  robots: 'noindex, nofollow',
};

export default function TestLayout({ children }: { children: React.ReactNode }) {
  // Test fixtures are only useful when userAccounts flag is on (dev/preview)
  if (!featureFlags.userAccounts) {
    redirect('/');
  }
  return <>{children}</>;
}
