'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { featureFlags } from '@/config/feature-flags';

// Test-fixture access gate.
//
// Test fixtures are dev/preview-only — a production user landing on
// /test/* should bounce to home. The gate previously lived in test/layout.tsx
// as a server-side `redirect()`, but `featureFlags.userAccounts` is a demo
// flag (depends on `window`), so the SSR check returned false unconditionally
// and only worked on demo via the build-time source rewrite. Moving the gate
// to a client component drops the source-rewrite dependency.

export function TestGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    if (featureFlags.userAccounts) {
      setAllowed(true);
    } else {
      setAllowed(false);
      router.replace('/');
    }
  }, [router]);

  if (allowed !== true) return null;
  return <>{children}</>;
}
