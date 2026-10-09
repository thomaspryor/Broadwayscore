'use client';

import Link from 'next/link';
import { featureFlags } from '@/config/feature-flags';
import { ACCOUNT_PROMO_COPY } from '@/config/email-list-copy';
import { useAuth } from '@/contexts/AuthContext';

const BUTTON = 'inline-flex items-center justify-center min-h-[40px] px-4 py-2 bg-brand hover:bg-brand-hover text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap';

/**
 * Footer box beside the email signup that promotes the free account
 * (BRO-4946). Signed in, it links to My Shows instead. While auth loads it
 * keeps its height but shows no button, so a signed-in visitor never sees
 * "Create a free account" flash.
 */
export default function FooterAccountBox() {
  const { loading, isAuthenticated, showSignIn } = useAuth();
  if (!featureFlags.userAccounts) return null;

  return (
    <div className="py-4">
      <p className="text-sm font-semibold text-white mb-1">{ACCOUNT_PROMO_COPY.heading}</p>
      <p className="text-xs text-gray-500 mb-3">{ACCOUNT_PROMO_COPY.pitch}</p>
      <div className="min-h-[40px]">
        {loading ? null : isAuthenticated ? (
          <Link href="/my-shows" className={BUTTON}>{ACCOUNT_PROMO_COPY.signedInButton}</Link>
        ) : (
          <button
            type="button"
            onClick={() => showSignIn('generic', 'footer_account_box', { returnTo: '/my-shows' })}
            className={BUTTON}
          >
            {ACCOUNT_PROMO_COPY.signedOutButton}
          </button>
        )}
      </div>
    </div>
  );
}

/** Footer link-row entry: account sign-up, or My Shows when signed in. */
export function FooterAccountLink() {
  const { loading, isAuthenticated, showSignIn } = useAuth();
  if (!featureFlags.userAccounts || loading) return null;
  return (
    <>
      <span className="text-gray-500 hidden sm:inline">|</span>
      {isAuthenticated ? (
        <Link href="/my-shows" className="hover:text-white transition-colors">{ACCOUNT_PROMO_COPY.linkSignedIn}</Link>
      ) : (
        <button
          type="button"
          onClick={() => showSignIn('generic', 'footer_link', { returnTo: '/my-shows' })}
          className="font-semibold text-brand hover:text-brand-hover transition-colors"
        >
          {ACCOUNT_PROMO_COPY.linkSignedOut}
        </button>
      )}
    </>
  );
}
