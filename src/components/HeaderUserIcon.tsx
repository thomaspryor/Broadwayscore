'use client';

import Link from 'next/link';
import { featureFlags } from '@/config/feature-flags';
import { useAuth } from '@/contexts/AuthContext';

/**
 * User icon in header — links to /my-shows when authenticated,
 * triggers sign-in when not. Only shows when userAccounts is enabled.
 */
export default function HeaderUserIcon() {
  const { isAuthenticated, profile, showSignIn } = useAuth();

  if (!featureFlags.userAccounts) return null;

  if (isAuthenticated) {
    return (
      <Link
        href="/my-shows"
        className="p-2 text-gray-400 hover:text-white transition-colors"
        aria-label="My Shows"
      >
        {profile?.avatar_url ? (
          <img
            src={profile.avatar_url}
            alt=""
            className="w-5 h-5 rounded-full border border-white/20"
          />
        ) : (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
          </svg>
        )}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={() => showSignIn('generic')}
      className="p-2 text-gray-400 hover:text-white transition-colors"
      aria-label="Sign In"
    >
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
      </svg>
    </button>
  );
}
