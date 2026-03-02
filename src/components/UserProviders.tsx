'use client';

import { type ReactNode } from 'react';
import { featureFlags } from '@/config/feature-flags';
import { AuthProvider } from '@/contexts/AuthContext';
import { ToastProvider } from '@/components/ui/Toast';

/**
 * Client component wrapper for user account providers.
 *
 * When userAccounts flag is OFF: renders children with only ToastProvider.
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
      </ToastProvider>
    </AuthProvider>
  );
}
