'use client';

/**
 * Google One Tap on desktop (BRO-6917 Part 5): Google's small corner card
 * that signs a visitor in with the Google account already in their browser.
 *
 * Dormant unless NEXT_PUBLIC_GOOGLE_CLIENT_ID is set at build time (the same
 * web client id Supabase's Google provider uses). Shown only to signed-out
 * visitors on a desktop-sized screen with a mouse, never on the sign-in
 * screens (shouldShowOneTap in src/lib/web-signup-onboarding.ts).
 *
 * Sign-in goes through Supabase signInWithIdToken with a nonce: Google gets
 * the SHA-256 of a random value, Supabase gets the value itself. The rest
 * (profile, analytics, welcome) runs off the normal SIGNED_IN event. A One
 * Tap sign-up is not a Sign in button sign-up, so it gets no setup sheet.
 */

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { getSupabaseClient } from '@/lib/supabase';
import { clearMidFlowSignIn } from '@/lib/signin-intent';
import { markSignInFailed, markSignInStarted, reportUgcError, trackUgc } from '@/lib/ugc-analytics';
import { ONE_TAP_SOURCE, recordSignUpSource, shouldShowOneTap } from '@/lib/web-signup-onboarding';

const GSI_SRC = 'https://accounts.google.com/gsi/client';

interface GoogleIdApi {
  initialize(config: Record<string, unknown>): void;
  prompt(listener?: (n: { isNotDisplayed?: () => boolean; getNotDisplayedReason?: () => string }) => void): void;
  cancel(): void;
}
type GoogleWindow = Window & { google?: { accounts?: { id?: GoogleIdApi } } };

let scriptPromise: Promise<void> | null = null;
function loadGsi(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GSI_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => { scriptPromise = null; reject(new Error('gsi_load_failed')); };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

async function makeNonce(): Promise<{ raw: string; hashed: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hashed = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return { raw, hashed };
}

export default function GoogleOneTap() {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const prompted = useRef(false);

  useEffect(() => {
    if (prompted.current || typeof window === 'undefined') return;
    const show = shouldShowOneTap({
      clientId,
      signedIn: !!user,
      authLoading: loading,
      pathname,
      viewportWidth: window.innerWidth,
      finePointer: window.matchMedia?.('(pointer: fine)').matches ?? false,
    });
    if (!show) return;
    prompted.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const [{ raw, hashed }] = await Promise.all([makeNonce(), loadGsi()]);
        const api = (window as GoogleWindow).google?.accounts?.id;
        if (cancelled || !api) return;
        api.initialize({
          client_id: clientId,
          nonce: hashed,
          auto_select: false,
          cancel_on_tap_outside: true,
          itp_support: true,
          use_fedcm_for_prompt: true,
          context: 'signin',
          callback: async (res: { credential?: string }) => {
            if (!res.credential) return;
            // Not a Sign in button, and not mid-task: no setup sheet after it.
            clearMidFlowSignIn();
            recordSignUpSource(ONE_TAP_SOURCE);
            markSignInStarted('google', ONE_TAP_SOURCE);
            const client = await getSupabaseClient();
            if (!client) { markSignInFailed('google', ONE_TAP_SOURCE, 'client_unavailable'); return; }
            const { error } = await client.auth.signInWithIdToken({ provider: 'google', token: res.credential, nonce: raw });
            if (error) {
              markSignInFailed('google', ONE_TAP_SOURCE, error.message);
              reportUgcError('auth.google_one_tap', { message: error.message, code: 'id_token' });
            }
          },
        });
        api.prompt();
        trackUgc('sign_in_prompt_shown', { context: 'generic', source: ONE_TAP_SOURCE });
      } catch {
        // Script blocked (extension, network): the normal Sign in still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId, user, loading, pathname]);

  // Signed in by any route while the card is up: take it down.
  useEffect(() => {
    if (!user) return;
    try { (window as GoogleWindow).google?.accounts?.id?.cancel(); } catch { /* not loaded */ }
  }, [user]);

  return null;
}
