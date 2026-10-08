'use client';

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { getSupabaseClient } from '@/lib/supabase';
import { saveReturnUrl, clearReturnUrl, clearPendingAction, safeReturnPath, takeSignInParam } from '@/lib/deferred-auth';
import { oauthRedirectUrl } from '@/lib/auth-redirect';
import { autoSubscribeOnSignIn } from '@/lib/auto-subscribe';
import type { UserProfile } from '@/types/user';
import SignInModal from '@/components/auth/SignInModal';
import { signInWithAppleSDK } from '@/lib/apple-auth';
import {
  trackUgc,
  reportUgcError,
  setAnalyticsUser,
  markSignInStarted,
  markSignInFailed,
  markSignInCompleted,
} from '@/lib/ugc-analytics';

type ModalContext = 'rating' | 'watchlist' | 'watchlist_local' | 'generic';

export type DeleteAccountResult = 'deleted' | 'session_expired' | 'failed';

interface AuthContextValue {
  user: { id: string; email: string } | null;
  profile: UserProfile | null;
  loading: boolean;
  isAuthenticated: boolean;
  /**
   * `source` names the entry point for analytics (e.g. 'my_shows').
   * `returnTo` is the page to land on afterwards; the current page when
   * omitted.
   */
  signIn: (provider: 'google' | 'apple', source?: string, returnTo?: string) => void;
  signOut: () => Promise<void>;
  /**
   * Permanently delete the signed-in account and everything it saved (the
   * delete-account edge function), then sign out. Resolves 'deleted' on
   * success. On failure the user stays signed in and the error is reported;
   * 'session_expired' means the server refused the sign-in token.
   */
  deleteAccount: () => Promise<DeleteAccountResult>;
  /**
   * Show sign-in modal. `context` picks the headline; `source` names the
   * button that asked (e.g. 'show_bookmark') so the funnel shows which entry
   * points bring sign-ups. `returnTo` is where sign-in lands afterwards (the
   * menu and header send people to My Shows); the current page when omitted.
   * Pass it here rather than calling saveReturnUrl() yourself: signIn() saves
   * the return page itself and would overwrite yours (BRO-4894).
   */
  showSignIn: (context?: ModalContext, source?: string, options?: SignInOptions) => void;
}

export interface SignInOptions {
  /** Same-site path to land on after sign-in, e.g. '/my-shows'. */
  returnTo?: string;
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
  const [modalContext, setModalContext] = useState<ModalContext>('generic');
  const [modalSource, setModalSource] = useState<string>('generic');
  const [modalReturnTo, setModalReturnTo] = useState<string | null>(null);
  const [signInLoading, setSignInLoading] = useState(false);

  // Google sign-in leaves for Google with the box showing "Signing in..." and
  // both buttons disabled. Safari (iOS above all) restores the page from its
  // back-forward cache when the person comes back with Back, state included,
  // so without this the box stayed stuck and nothing but a reload could clear
  // it (BRO-4894: an iPhone did exactly that on 2026-10-08 and gave up).
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setSignInLoading(false);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  // Initialize auth state on mount
  useEffect(() => {
    const client = getSupabaseClient();
    if (!client) {
      setLoading(false);
      return;
    }

    // Get existing session
    client.auth.getSession().then(({ data: { session } }) => {
      setAnalyticsUser(session?.user?.id ?? null);
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
        setAnalyticsUser(session.user.id);
        // No-op unless a sign-in was started on this device (SIGNED_IN also
        // fires for restored sessions and tab refocus).
        markSignInCompleted(session.user);
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
        setAnalyticsUser(null);
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
        // The failed response is already counted by instrumentedFetch; this
        // names it so a missing-profile bug is findable by op.
        // eslint-disable-next-line no-console
        console.error('[Auth] Profile upsert failed:', upsertErr.message);
      }
      if (data) {
        setProfile(data as UserProfile);
      }
    } catch (e) {
      reportUgcError('auth.ensure_profile', { message: e instanceof Error ? e.message : String(e), code: 'exception' });
      // eslint-disable-next-line no-console
      console.error('[Auth] ensureProfile error:', e);
    }
  };

  const signIn = useCallback(async (provider: 'google' | 'apple', source: string = 'unknown', returnTo?: string) => {
    const client = getSupabaseClient();
    if (!client) return;
    markSignInStarted(provider, source);

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
        // The menu and header promise My Shows after sign-in; keep that
        // promise on the popup path too (no reload when already there).
        if (returnTo) {
          const target = safeReturnPath(returnTo);
          if (target !== window.location.pathname + window.location.search) window.location.assign(target);
        }
      } catch (err) {
        setSignInLoading(false);
        // User closed popup or Apple error — not a crash. The SDK rejects
        // with { error: 'popup_closed_by_user' } on a plain cancel.
        const raw = (err as { error?: string })?.error
          || (err instanceof Error ? err.message : String(err));
        const cancelled = /popup_closed|cancel/i.test(raw);
        markSignInFailed('apple', source, cancelled ? 'cancelled' : raw);
        if (!cancelled) reportUgcError('auth.apple_sign_in', { message: raw, code: 'apple' });
        // eslint-disable-next-line no-console
        console.error('[Auth] Apple sign-in error:', err);
      }
      return;
    }

    // Google: standard OAuth redirect flow. The requested page wins; the
    // current page otherwise.
    saveReturnUrl(returnTo);
    const { error } = await client.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: oauthRedirectUrl(window.location.origin),
      },
    });
    if (error) {
      // Never navigated away: without this the modal spinner runs forever.
      setSignInLoading(false);
      markSignInFailed('google', source, error.message);
      reportUgcError('auth.google_sign_in', { message: error.message, code: 'oauth_start' });
    }
  }, []);

  const signOut = useCallback(async () => {
    const client = getSupabaseClient();
    if (!client) return;

    trackUgc('sign_out');
    // This device only. The default ('global') revokes every session the
    // account has, so signing out of the iOS app or another browser silently
    // signed the owner's phone out too (BRO-4822).
    await client.auth.signOut({ scope: 'local' });
    // A draft rating left by a signed-out visitor must not open for whoever signs in next on this device.
    clearPendingAction();
    setAnalyticsUser(null);
    setUser(null);
    setProfile(null);
  }, []);

  const deleteAccount = useCallback(async (): Promise<DeleteAccountResult> => {
    const client = getSupabaseClient();
    if (!client) return 'failed';

    trackUgc('account_delete_started');
    // The function answers 200 with {ok:false} for handled failures, so
    // check the body, not only the transport error.
    const { data, error } = await client.functions.invoke('delete-account', { body: {} });
    const body = (data ?? null) as { ok?: boolean; error?: string } | null;
    if (error || body?.ok !== true) {
      // 401 from the functions gateway (bad or expired JWT) or the function's
      // own 'unauthorized': the user has to sign in again before retrying.
      const status = (error as { context?: { status?: number } } | null)?.context?.status;
      const expired = status === 401 || body?.error === 'unauthorized';
      reportUgcError('auth.delete_account', {
        message: error?.message || body?.error || 'no ok in response',
        code: expired ? 'session_expired' : body?.error || 'delete_failed',
        status,
      });
      return expired ? 'session_expired' : 'failed';
    }

    trackUgc('account_deleted');
    // Deleting the auth user already revoked its sessions server-side, so
    // only this device's session needs clearing. auth-js still calls /logout
    // and gets a 403 for the deleted user; reportUgcError ignores that.
    await client.auth.signOut({ scope: 'local' }).catch(() => {});
    setAnalyticsUser(null);
    setUser(null);
    setProfile(null);
    return 'deleted';
  }, []);

  const showSignIn = useCallback((context: ModalContext = 'generic', source?: string, options?: SignInOptions) => {
    const src = source || context;
    setModalContext(context);
    setModalSource(src);
    setModalReturnTo(options?.returnTo ?? null);
    setModalOpen(true);
    trackUgc('sign_in_prompt_shown', { context, source: src });
  }, []);

  // `?signin=1` (the account line in our emails, BRO-4893) opens the sign-in
  // modal once auth has settled. Read window.location after mount, not
  // the Next search-params hook (it bails the static export to client rendering,
  // BRO-4597). Strip the param first: Google sign-in returns to the saved URL,
  // and a param left in place would reopen the modal after signing in.
  useEffect(() => {
    if (loading || !getSupabaseClient()) return;
    const signInLinkSource = takeSignInParam();
    if (signInLinkSource && !user) showSignIn('generic', signInLinkSource);
  }, [loading, user, showSignIn]);

  const handleModalSignIn = useCallback((provider: 'google' | 'apple') => {
    if (provider !== 'apple') setSignInLoading(true);
    signIn(provider, modalSource, modalReturnTo ?? undefined);
  }, [signIn, modalSource, modalReturnTo]);

  const handleModalClose = useCallback(() => {
    setModalOpen(false);
    setModalReturnTo(null);
    trackUgc('sign_in_prompt_dismissed', { context: modalContext, source: modalSource });
  }, [modalContext, modalSource]);

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        isAuthenticated: !!user,
        signIn,
        signOut,
        deleteAccount,
        showSignIn,
      }}
    >
      {children}
      <SignInModal
        isOpen={modalOpen}
        onClose={handleModalClose}
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
  signOut: async () => {},
  deleteAccount: async () => 'failed',
  showSignIn: () => {},
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  // During SSG prerender, context may be null — return safe defaults
  return context || DEFAULT_AUTH;
}
