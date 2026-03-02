'use client';

import { useEffect, useState } from 'react';
import { getSupabaseClient } from '@/lib/supabase';
import { getReturnUrl, clearReturnUrl } from '@/lib/deferred-auth';

/**
 * OAuth callback handler.
 *
 * CRITICAL: Do NOT manually parse URL params.
 * Supabase PKCE flow returns tokens in URL hash fragments (#access_token=...).
 * supabase.auth.onAuthStateChange() handles this automatically.
 *
 * Flow:
 * 1. User signs in with Google → redirected here with hash fragment
 * 2. onAuthStateChange fires SIGNED_IN event
 * 3. Redirect to stored return URL
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
      setErrorDetail(`${urlError}: ${urlErrorDesc || 'Unknown error'}`);
      setError(true);
      return;
    }

    const client = getSupabaseClient();
    if (!client) {
      setErrorDetail('Supabase client not available — env vars may be missing');
      setError(true);
      return;
    }

    // Set up timeout — if auth doesn't complete in 8s, show error
    const timeout = setTimeout(() => {
      setErrorDetail('Timed out waiting for auth callback. Hash: ' + (hash ? hash.substring(0, 80) : '(empty)'));
      setError(true);
    }, 8000);

    // Listen for auth state change (handles hash fragment automatically)
    const { data: { subscription } } = client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') {
        clearTimeout(timeout);
        const returnUrl = getReturnUrl();
        clearReturnUrl();
        // Small delay to ensure session is persisted
        setTimeout(() => {
          window.location.href = returnUrl;
        }, 100);
      }
    });

    return () => {
      clearTimeout(timeout);
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
          className="inline-block px-5 py-2.5 text-sm font-semibold text-black bg-[#FFD700] rounded-lg hover:bg-[#e6c200] transition-colors"
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
