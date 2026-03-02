'use client';

import { featureFlags } from '@/config/feature-flags';
import { useAuth } from '@/contexts/AuthContext';
import HamburgerMenu from '@/components/HamburgerMenu';

/**
 * Header hamburger menu button — client component for server layout.
 * Only renders when userAccounts feature flag is enabled.
 */
export default function HeaderHamburger() {
  const { isAuthenticated, profile, showSignIn, signOut } = useAuth();

  if (!featureFlags.userAccounts) return null;

  return (
    <HamburgerMenu
      isAuthenticated={isAuthenticated}
      profile={profile}
      onSignIn={() => showSignIn('generic')}
      onSignOut={signOut}
    />
  );
}
