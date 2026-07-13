'use client';

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { getSupabaseClient } from '@/lib/supabase';
import { saveReturnUrl, clearReturnUrl } from '@/lib/deferred-auth';
import { autoSubscribeOnSignIn } from '@/lib/auto-subscribe';
import type { UserProfile } from '@/types/user';
import SignInModal from '@/components/auth/SignInModal';
import { signInWithAppleSDK } from '@/lib/apple-auth';

interface AuthContextValue {
  user: { id: string; email: string } | null;
  profile: UserProfile | null;
  loading: boolean;
  isAuthenticated: boolean;
  signIn: (provider: 'google' | 'apple') => void;
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
        // Restored sessions too (not just fresh SIGNED_IN): users who signed
        // up before auto-subscribe shipped must still land on the list.
        // Fire-and-forget; internally idempotent.
        if (session.user.email) autoSubscribeOnSignIn(session.user.email);
      }
      setLoading(false);
    });

    // Listen for auth state changes
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        setUser({ id: session.user.id, email: session.user.email || '' });
        // IMPORTANT: Do NOT await Supabase queries here.
        // _notifyAllSubscribers awaits this callback during initialize(),
        // but getSession() awaits initializePromise — creating a deadlock.
        // Fire-and-forget is safe; loadProfile has its own error handling.
        loadProfile(session.user.id);
        // Signing in = joining the main mailing list (owner decision 2026-07-13).
        // Also fire-and-forget — never await inside this callback (deadlock note above).
        if (session.user.email) autoSubscribeOnSignIn(session.user.email);
        setModalOpen(false);
        setSignInLoading(false);

        // Pending action execution handled by consuming components
        // (e.g. ShowHeroRedesign reads and clears the pending action)
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
        const profile = data as UserProfile;
        // If display_name or avatar_url is missing, backfill from auth metadata
        if (!profile.display_name || !profile.avatar_url) {
          await ensureProfile(userId);
        } else {
          setProfile(profile);
        }
      } else {
        // Profile doesn't exist yet — create it client-side
        await ensureProfile(userId);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[Auth] loadProfile error:', e);
      await ensureProfile(userId);
    }
  };

  const ensureProfile = async (userId: string) => {
    const client = getSupabaseClient();
    if (!client) return;

    try {
      const { data: { user: authUser } } = await client.auth.getUser();
      const meta = authUser?.user_metadata || {};
      const { data, error: upsertErr } = await client
        .from('profiles')
        .upsert({
          id: userId,
          display_name: meta.full_name || meta.name || '',
          avatar_url: meta.avatar_url || meta.picture || null,
        }, { onConflict: 'id' })
        .select()
        .single();

      if (upsertErr) {
        // eslint-disable-next-line no-console
        console.error('[Auth] Profile upsert failed:', upsertErr.message);
      }
      if (data) {
        setProfile(data as UserProfile);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[Auth] ensureProfile error:', e);
    }
  };

  const signIn = useCallback(async (provider: 'google' | 'apple') => {
    const client = getSupabaseClient();
    if (!client) return;

    if (provider === 'apple') {
      // Apple: use JS SDK + signInWithIdToken (bypasses GoTrue code exchange)
      try {
        setSignInLoading(true);
        const result = await signInWithAppleSDK();

        const { data, error } = await client.auth.signInWithIdToken({
          provider: 'apple',
          token: result.idToken,
          nonce: result.nonce,
        });

        if (error) throw error;

        // Apple only returns user name on first sign-in — save it
        if (result.user && data.user) {
          const fullName = [result.user.firstName, result.user.lastName].filter(Boolean).join(' ');
          if (fullName) {
            await client.auth.updateUser({
              data: { full_name: fullName },
            });
          }
        }

        // Apple popup flow doesn't navigate the page, so no redirect needed.
        // The onAuthStateChange SIGNED_IN event handles UI updates.
        // Clear any stale return URL from a previous Google flow attempt.
        clearReturnUrl();
      } catch (err) {
        setSignInLoading(false);
        // User closed popup or Apple error — not a crash
        // eslint-disable-next-line no-console
        console.error('[Auth] Apple sign-in error:', err);
      }
      return;
    }

    // Google: standard OAuth redirect flow
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

  const handleModalSignIn = useCallback((provider: 'google' | 'apple') => {
    if (provider !== 'apple') setSignInLoading(true);
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
