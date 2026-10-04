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
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

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
      setErrorDetail(`${urlError}: ${urlErrorDesc || 'Unknown error'}`);
      setError(true);
      return;
    }

    const client = getSupabaseClient();
    if (!client) {
      reportUgcError('auth.callback', { message: 'Supabase client not available', code: 'no_client' });
      setErrorDetail('Supabase client not available — env vars may be missing');
      setError(true);
      return;
    }

    let redirected = false;

    const doRedirect = () => {
      if (redirected) return;
      redirected = true;
      const returnUrl = getReturnUrl();
      clearReturnUrl();
      setTimeout(() => {
        // The profile fetch AuthContext started is still in flight; the
        // navigation cancels it, which is not a failure.
        markPageLeaving();
        window.location.href = returnUrl;
      }, 100);
    };

    // Strategy 1: Listen for auth state change event
    const { data: { subscription } } = client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') {
        doRedirect();
      }
    });

    // Strategy 2: Poll getSession() to catch already-completed auth
    // (handles race condition where AuthProvider caught the event first)
    const pollInterval = setInterval(async () => {
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

    // Timeout after 10s
    const timeout = setTimeout(() => {
      clearInterval(pollInterval);
      // Never echo the hash: it holds the access token.
      const hashPresent = hash.length > 1;
      markSignInFailed('google', null, 'timeout');
      reportUgcError('auth.callback', { message: `Timed out waiting for session (hash present: ${hashPresent})`, code: 'timeout' });
      setErrorDetail(`Timed out waiting for sign-in to finish (token ${hashPresent ? 'received' : 'missing'}).`);
      setError(true);
    }, 10000);

    return () => {
      clearTimeout(timeout);
      clearInterval(pollInterval);
      subscription.unsubscribe();
    };
  }, []);

  if (error) {
    return (
      <div className="max-w-sm mx-auto px-4 pt-20 text-center">
        <div className="text-4xl mb-4">🎭</div>
        <h1 className="text-xl font-bold text-white mb-2">Sign-in failed</h1>
        <p className="text-sm text-gray-400 mb-6">
          Something went wrong during sign-in. Please try again.
        </p>
        {errorDetail && (
          <p className="text-xs text-gray-600 mb-4 font-mono break-all bg-white/5 rounded p-2">
            {errorDetail}
          </p>
        )}
        <a
          href="/"
          className="btn-primary text-sm"
        >
          Go Home
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
