'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { UserProfile } from '@/types/user';
import SignInModal from '@/components/auth/SignInModal';

interface AuthContextValue {
  user: { id: string; email: string } | null;
  profile: UserProfile | null;
  loading: boolean;
  isAuthenticated: boolean;
  signIn: (provider: 'google') => void;
  signOut: () => void;
  /** Show sign-in modal with context */
  showSignIn: (context?: 'rating' | 'watchlist' | 'generic') => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * AuthProvider — wraps the app to provide auth state.
 *
 * Sprint 1: Stub implementation (no Supabase client).
 * Sprint 2: Wire to real Supabase auth.
 *
 * CRITICAL: Renders children normally when Supabase client is null
 * (feature flag OFF or during SSG build). This is NOT optional —
 * breaking this will crash the static export.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  // Sprint 2: Replace these stubs with real Supabase auth
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalContext, setModalContext] = useState<'rating' | 'watchlist' | 'generic'>('generic');
  const [signInLoading, setSignInLoading] = useState(false);

  const signIn = useCallback((provider: 'google') => {
    // Sprint 2: supabase.auth.signInWithOAuth({ provider })
    console.log('[AuthProvider] signIn called with provider:', provider);
  }, []);

  const signOut = useCallback(() => {
    // Sprint 2: supabase.auth.signOut()
    setUser(null);
    setProfile(null);
  }, []);

  const showSignIn = useCallback((context: 'rating' | 'watchlist' | 'generic' = 'generic') => {
    setModalContext(context);
    setModalOpen(true);
  }, []);

  const handleModalSignIn = useCallback((provider: 'google') => {
    setSignInLoading(true);
    signIn(provider);
    // Sprint 2: modal closes on auth state change
    setTimeout(() => setSignInLoading(false), 1000);
  }, [signIn]);

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        isAuthenticated: !!user,
        signIn,
        signOut,
        showSignIn,
      }}
    >
      {children}
      <SignInModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSignIn={handleModalSignIn}
        context={modalContext}
        loading={signInLoading}
      />
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
