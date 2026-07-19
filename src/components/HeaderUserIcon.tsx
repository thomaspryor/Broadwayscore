'use client';

import Link from 'next/link';
import { featureFlags } from '@/config/feature-flags';
import { useAuth } from '@/contexts/AuthContext';
import { saveReturnUrl } from '@/lib/deferred-auth';

/**
 * User icon in header — links to /my-shows when authenticated,
 * triggers sign-in when not. Only shows when userAccounts is enabled.
 */
export default function HeaderUserIcon() {
  const { isAuthenticated, profile, showSignIn } = useAuth();

  if (!featureFlags.userAccounts) return null;

  // Mobile hides this standalone control entirely: three 44px tap targets +
  // logo + market pill can't fit a phone header, and the clipped avatar looked
  // broken (owner report, 2026-07-17). On phones the hamburger trigger itself
  // renders the avatar and the menu carries My Shows / Sign in.
  if (isAuthenticated) {
    return (
      <Link
        href="/my-shows"
        className="hidden sm:flex items-center shrink-0 gap-1.5 px-2 py-1.5 text-sm text-gray-400 hover:text-white transition-colors rounded-lg hover:bg-white/[0.05]"
        aria-label="My Shows"
      >
        {profile?.avatar_url ? (
          <img
            src={profile.avatar_url}
            alt=""
            className="w-6 h-6 rounded-full border border-white/20"
          />
        ) : (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
          </svg>
        )}
        <span className="hidden sm:inline">My Shows</span>
      </Link>
    );
  }

  // Signed out: a labeled pill on desktop (the bare icon read as nothing —
  // owner, 2026-07-12); icon-only on mobile where the header is tight.
  return (
    <button
      type="button"
      onClick={() => { saveReturnUrl('/my-shows'); showSignIn('generic'); }}
      className="hidden sm:flex items-center shrink-0 gap-1.5 px-3.5 py-1.5 rounded-lg text-gray-300 hover:text-white bg-white/10 border border-white/15 hover:bg-white/15 hover:border-white/25 transition-colors text-sm font-semibold"
      aria-label="Sign in"
    >
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
      </svg>
      <span className="hidden sm:inline">Sign in</span>
    </button>
  );
}
