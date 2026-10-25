'use client';

import { featureFlags } from '@/config/feature-flags';

export function AwardsNavLink({ hasAwards }: { hasAwards: boolean }) {
  if (!featureFlags.awards || !hasAwards) return null;
  return (
    <a href="#awards" className="inline-flex items-center px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white leading-none transition-colors">Awards</a>
  );
}
