'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { featureFlags } from '@/config/feature-flags';
import { useAuth } from '@/contexts/AuthContext';
import { useToastSafe } from '@/components/ui/Toast';
import HamburgerMenu from '@/components/HamburgerMenu';
import DeleteAccountDialog from '@/components/auth/DeleteAccountDialog';

/**
 * Header hamburger menu button — client component for server layout.
 * Only renders when userAccounts feature flag is enabled.
 */
export default function HeaderHamburger() {
  const { isAuthenticated, loading, user, profile, showSignIn, signOut, deleteAccount } = useAuth();
  const { showToast } = useToastSafe();
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!featureFlags.userAccounts) return null;

  const handleDelete = async () => {
    const result = await deleteAccount();
    if (result === 'deleted') {
      showToast('Your account has been deleted.', 'info');
      router.push('/');
    }
    return result;
  };

  // An expired session can't authorize the delete. Clear it and reopen sign-in;
  // signIn saves the current page, so the user lands back where they were.
  const handleSignInAgain = async () => {
    setConfirmDelete(false);
    await signOut();
    showSignIn('generic', 'delete_account_reauth');
  };

  return (
    <>
      <HamburgerMenu
        isAuthenticated={isAuthenticated}
        authLoading={loading}
        profile={profile}
        email={user?.email}
        onSignIn={(context, options) => showSignIn(context, 'menu', options)}
        onSignOut={signOut}
        onDeleteAccount={() => setConfirmDelete(true)}
      />
      <DeleteAccountDialog
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
        onSignInAgain={handleSignInAgain}
      />
    </>
  );
}
