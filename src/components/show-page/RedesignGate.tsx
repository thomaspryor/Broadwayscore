'use client';

import { featureFlags } from '@/config/feature-flags';

// Demo feature flags depend on `window` (isDemo runtime check) or build-time
// source rewrite (vercel-demo.yml). Reading them in server components is
// fragile because isDemo() returns false during SSR and the flag silently
// disappears unless the source-rewrite is applied — which CI lints catch.
//
// These wrappers gate JSX subtrees on `featureFlags.showPageRedesign` from a
// 'use client' module. The flag still resolves correctly server-side on demo
// (source rewrite at build) and client-side on every deploy.
//
// Server pages that need to read the flag should pass server-rendered children
// into <RedesignOn>/<RedesignOff>, not duplicate the conditional inline.

export function RedesignOn({ children }: { children: React.ReactNode }) {
  if (!featureFlags.showPageRedesign) return null;
  return <>{children}</>;
}

export function RedesignOff({ children }: { children: React.ReactNode }) {
  if (featureFlags.showPageRedesign) return null;
  return <>{children}</>;
}
