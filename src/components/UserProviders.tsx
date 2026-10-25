'use client';

import { type ReactNode } from 'react';
import { featureFlags } from '@/config/feature-flags';
import { AuthProvider } from '@/contexts/AuthContext';
import { ToastProvider } from '@/components/ui/Toast';
import WelcomeGate from '@/components/onboarding/WelcomeGate';

/**
 * Client component wrapper for user account providers.
 *
 * When userAccounts flag is OFF: renders children bare (no providers).
 * When ON: wraps with AuthProvider + ToastProvider.
 *
 * This is always safe to render (including during SSG build)
 * because AuthProvider handles null Supabase client gracefully.
 */
export default function UserProviders({ children }: { children: ReactNode }) {
  if (!featureFlags.userAccounts) {
    return <>{children}</>;
  }

  return (
    <AuthProvider>
      <ToastProvider>
        {children}
        <WelcomeGate />
      </ToastProvider>
    </AuthProvider>
  );
}
