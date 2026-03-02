'use client';

import { featureFlags } from '@/config/feature-flags';
import HamburgerMenu from '@/components/HamburgerMenu';

/**
 * Header hamburger menu button — client component for server layout.
 * Only renders when userAccounts feature flag is enabled.
 * Auth state wired in Sprint 2 via useAuth().
 */
export default function HeaderHamburger() {
  if (!featureFlags.userAccounts) return null;

  // Sprint 2: const { isAuthenticated, profile, showSignIn, signOut } = useAuth();

  return (
    <HamburgerMenu
      isAuthenticated={false}
      profile={null}
      onSignIn={() => {
        // Sprint 2: showSignIn('generic')
      }}
      onSignOut={() => {
        // Sprint 2: signOut()
      }}
    />
  );
}
