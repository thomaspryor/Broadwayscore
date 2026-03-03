'use client';

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { getSupabaseClient } from '@/lib/supabase';
import { saveReturnUrl, getPendingAction, clearPendingAction } from '@/lib/deferred-auth';
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
 * CRITICAL: Renders children normally when Supabase client is null
 * (feature flag OFF or during SSG build). This is NOT optional —
 * breaking this will crash the static export.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalContext, setModalContext] = useState<'rating' | 'watchlist' | 'generic'>('generic');
  const [signInLoading, setSignInLoading] = useState(false);

  // Initialize auth state on mount
  useEffect(() => {
    const client = getSupabaseClient();
    if (!client) {
      setLoading(false);
      return;
    }

    // Get existing session
    client.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setUser({ id: session.user.id, email: session.user.email || '' });
        loadProfile(session.user.id);
      }
      setLoading(false);
    });

    // Listen for auth state changes
    const { data: { subscription } } = client.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        setUser({ id: session.user.id, email: session.user.email || '' });
        await loadProfile(session.user.id);
        setModalOpen(false);
        setSignInLoading(false);

        // Execute pending action (deferred auth)
        const pending = getPendingAction();
        if (pending) {
          // Clear AFTER confirming auth success, not before
          clearPendingAction();
          // Pending action execution handled by consuming components
        }
      } else if (event === 'SIGNED_OUT') {
        setUser(null);
        setProfile(null);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const loadProfile = async (userId: string) => {
    const client = getSupabaseClient();
    if (!client) return;

    try {
      const { data } = await client
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

      if (data) {
        setProfile(data as UserProfile);
      } else {
        // Profile doesn't exist yet — create it client-side
        // (handles case where DB trigger is missing or failed)
        await ensureProfile(userId);
      }
    } catch {
      // Profile not found — create it
      await ensureProfile(userId);
    }
  };

  const ensureProfile = async (userId: string) => {
    const client = getSupabaseClient();
    if (!client) return;

    try {
      const { data: { user: authUser } } = await client.auth.getUser();
      const meta = authUser?.user_metadata || {};
      const { data } = await client
        .from('profiles')
        .upsert({
          id: userId,
          display_name: meta.full_name || meta.name || '',
          avatar_url: meta.avatar_url || meta.picture || null,
        }, { onConflict: 'id' })
        .select()
        .single();

      if (data) {
        setProfile(data as UserProfile);
      }
    } catch {
      // Non-fatal — profile will be created on next sign-in
    }
  };

  const signIn = useCallback((provider: 'google') => {
    const client = getSupabaseClient();
    if (!client) return;

    // Save return URL before redirect
    saveReturnUrl();

    client.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
  }, []);

  const signOut = useCallback(async () => {
    const client = getSupabaseClient();
    if (!client) return;

    await client.auth.signOut();
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

const DEFAULT_AUTH: AuthContextValue = {
  user: null,
  profile: null,
  loading: false,
  isAuthenticated: false,
  signIn: () => {},
  signOut: () => {},
  showSignIn: () => {},
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  // During SSG prerender, context may be null — return safe defaults
  return context || DEFAULT_AUTH;
}
