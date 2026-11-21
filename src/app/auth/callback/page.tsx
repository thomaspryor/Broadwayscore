'use client';

import { useEffect, useState } from 'react';
import { getSupabaseClient } from '@/lib/supabase';
import { getReturnUrl, clearReturnUrl } from '@/lib/deferred-auth';
import { markPageLeaving, markSignInFailed, reportUgcError } from '@/lib/ugc-analytics';

/**
 * OAuth callback handler.
 *
 * Implicit flow: Supabase returns tokens in URL hash (#access_token=...).
 * detectSessionInUrl in the Supabase client handles parsing automatically.
 *
 * Race condition fix: The AuthProvider's onAuthStateChange may fire SIGNED_IN
 * before this page registers its own listener. So we also poll getSession()
 * to catch the case where auth already completed.
 */
export default function AuthCallbackPage() {
  const [error, setError] = useState(false);

  useEffect(() => {
    // Check for error in URL hash or query params
    const hash = window.location.hash;
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(hash.replace('#', ''));

    const urlError = params.get('error') || hashParams.get('error');
    const urlErrorDesc = params.get('error_description') || hashParams.get('error_description');

    if (urlError) {
      // Backing out of Google's consent screen is a choice, not a failure:
      // send them back where they were instead of a "Sign-in failed" page.
      if (urlError === 'access_denied') {
        markSignInFailed('google', null, 'cancelled');
        const returnUrl = getReturnUrl();
        clearReturnUrl();
        markPageLeaving();
        window.location.replace(returnUrl);
        return;
      }
      markSignInFailed('google', null, urlError);
      reportUgcError('auth.callback', { message: `${urlError}: ${urlErrorDesc || ''}`, code: urlError });
      setError(true);
      return;
    }

    // Timeout, started before the SDK loads so a stalled chunk load still
    // ends in the error screen rather than a spinner forever. 15s: the old
    // 10s budget started after a synchronous client, this one includes the
    // SDK download.
    let pollInterval: ReturnType<typeof setInterval> | undefined;
    let redirectTimer: ReturnType<typeof setTimeout> | undefined;
    let finalCheckTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let redirected = false;
    let cleanup: (() => void) | undefined;
    const clientPromise = getSupabaseClient();

    const doRedirect = () => {
      if (cancelled || redirected) return;
      redirected = true;
      clearTimeout(timeout);
      clearTimeout(finalCheckTimer);
      clearInterval(pollInterval);
      setError(false);
      const returnUrl = getReturnUrl();
      clearReturnUrl();
      redirectTimer = setTimeout(() => {
        // Navigation cancels the profile request started by AuthContext.
        markPageLeaving();
        window.location.href = returnUrl;
      }, 100);
    };

    const timeout = setTimeout(async () => {
      clearInterval(pollInterval);
      // A slow SDK load or session write can finish at the deadline. Check
      // once more before recording a failed sign-in. Bound this last check
      // too, so a stuck SDK/session lock cannot leave the spinner forever.
      const sessionReady = clientPromise.then(async client => {
        const result = await client?.auth.getSession();
        return !!result?.data.session?.user;
      }).catch(() => false);
      const ready = await Promise.race([
        sessionReady,
        new Promise<boolean>(resolve => {
          finalCheckTimer = setTimeout(() => resolve(false), 5000);
        }),
      ]);
      clearTimeout(finalCheckTimer);
      if (cancelled || redirected) return;
      if (ready) {
        doRedirect();
        return;
      }
      // Never echo the hash: it holds the access token.
      const hashPresent = hash.length > 1;
      markSignInFailed('google', null, 'timeout');
      reportUgcError('auth.callback', { message: `Timed out waiting for session (hash present: ${hashPresent})`, code: 'timeout' });
      setError(true);
    }, 15000);

    // The SDK loads on demand (lib/supabase.ts); wait for it here.
    clientPromise.then((client) => {
      if (cancelled || redirected) return;
      if (!client) {
        clearTimeout(timeout);
        reportUgcError('auth.callback', { message: 'Supabase client not available', code: 'no_client' });
        setError(true);
        return;
      }

      // Strategy 1: Listen for auth state change event
      const { data: { subscription } } = client.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_IN') {
          doRedirect();
        }
      });

      // Strategy 2: Poll getSession() to catch already-completed auth
      // (handles race condition where AuthProvider caught the event first)
      pollInterval = setInterval(async () => {
        try {
          const { data: { session } } = await client.auth.getSession();
          if (session?.user) {
            clearInterval(pollInterval);
            doRedirect();
          }
        } catch {
          // ignore polling errors
        }
      }, 500);

      cleanup = () => subscription.unsubscribe();
    });

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      clearTimeout(finalCheckTimer);
      clearTimeout(redirectTimer);
      if (pollInterval) clearInterval(pollInterval);
      cleanup?.();
    };
  }, []);

  if (error) {
    // Start a fresh sign-in on the original page via AuthProvider's existing
    // signin link handler. Reloading this callback would replay provider errors.
    const retryUrl = new URL(getReturnUrl(), window.location.origin);
    retryUrl.searchParams.set('signin', '1');
    return (
      <div className="max-w-sm mx-auto px-4 pt-20 text-center">
        <div className="text-4xl mb-4">🎭</div>
        <h1 className="text-xl font-bold text-white mb-2">Sign-in couldn’t finish</h1>
        <p className="text-sm text-gray-400 mb-6">
          We couldn’t finish signing you in. Check your connection and try again.
        </p>
        {/* Full reload on purpose: leaves a broken client state behind. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href={retryUrl.pathname + retryUrl.search + retryUrl.hash}
          className="btn-primary text-sm"
        >
          Retry
        </a>
      </div>
    );
  }

  return (
    <div className="max-w-sm mx-auto px-4 pt-20 text-center">
      <div className="animate-spin w-8 h-8 border-2 border-brand border-t-transparent rounded-full mx-auto mb-4" />
      <p className="text-sm text-gray-400">Completing sign-in...</p>
    </div>
  );
}
