'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { featureFlags } from '@/config/feature-flags';
import { isTestFixtureHost } from '@/lib/test-fixture-host';

// Test-fixture access gate.
//
// Test fixtures are dev/preview-only — a production user landing on
// /test/* should bounce to home. The gate previously lived in test/layout.tsx
// as a server-side `redirect()` while `featureFlags.userAccounts` was a demo
// flag (depends on `window`), so the SSR check returned false unconditionally
// and only worked on demo via the build-time source rewrite. It stays a client
// component because it reads window.location.hostname.
//
// userAccounts launched on prod 2026-10-02 (BRO-4525), so the flag no longer
// gates anything on its own: the host check (isTestFixtureHost) is what keeps
// the fixtures off broadwayscorecard.com. They render on local dev/CI servers
// and the demo site only.

export function TestGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    if (featureFlags.userAccounts && isTestFixtureHost(window.location.hostname)) {
      setAllowed(true);
    } else {
      setAllowed(false);
      router.replace('/');
    }
  }, [router]);

  if (allowed !== true) return null;
  return <>{children}</>;
}
