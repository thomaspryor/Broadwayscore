'use client';

import { featureFlags } from '@/config/feature-flags';
import { ACCOUNT_NUDGE_COPY } from '@/config/email-list-copy';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Points email-list members to a free account (BRO-4893): joining the list is
 * not an account, and people read it as one.
 *
 * Renders nothing when accounts are off, while auth is still loading (so a
 * signed-in member never sees a flash of "Create a free account"), or when
 * the visitor is already signed in. Must sit inside UserProviders, otherwise
 * showSignIn is a no-op.
 */
export default function CreateAccountNudge({ source, className = '' }: { source: string; className?: string }) {
  const { loading, isAuthenticated, showSignIn } = useAuth();

  if (!featureFlags.userAccounts || loading || isAuthenticated) return null;

  return (
    <div className={`text-center ${className}`}>
      <p className="text-sm text-gray-400">
        {ACCOUNT_NUDGE_COPY.separate} {ACCOUNT_NUDGE_COPY.pitch}
      </p>
      <button
        type="button"
        onClick={() => showSignIn('generic', source)}
        className="mt-3 min-h-[44px] px-4 py-2 text-sm font-semibold text-white bg-white/10 border border-white/15 hover:bg-white/15 hover:border-white/25 rounded-lg transition-colors"
      >
        {ACCOUNT_NUDGE_COPY.button}
      </button>
    </div>
  );
}
