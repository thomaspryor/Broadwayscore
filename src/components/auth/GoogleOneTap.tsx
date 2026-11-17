'use client';

/**
 * Google One Tap for signed-out desktop visitors (BRO-6917 Part 5).
 *
 * Renders nothing. After a short wait it loads Google's script and asks for the
 * "Continue as <name>" card, which Google draws in the top-right corner. It is
 * never a full-screen pop-up and it never takes focus from the page.
 *
 * Quiet by design: desktop only, once per browser session, never while the
 * normal sign-in box is open or on the OAuth return pages, and silent for 14
 * days after the visitor closes it. If Google's script is blocked, or the site
 * is not an authorised origin for the client, nothing shows and nothing breaks;
 * the reason is tracked (one_tap_not_displayed) so a misconfiguration is
 * visible instead of silent.
 *
 * Mounted once by UserProviders, inside AuthProvider.
 */

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { trackUgc } from '@/lib/ugc-analytics';
import {
  DESKTOP_QUERY,
  GOOGLE_WEB_CLIENT_ID,
  ONE_TAP_DELAY_MS,
  ONE_TAP_SOURCE,
  loadGoogleIdentity,
  markAskedThisSession,
  markDismissed,
  oneTapDecision,
  readAskedThisSession,
  readDismissedAt,
  readPromptOutcome,
  shouldCooldown,
  type GoogleIdApi,
} from '@/lib/google-one-tap';

export default function GoogleOneTap() {
  const { user, loading, signInModalOpen, signInWithGoogleCredential } = useAuth();
  const pathname = usePathname() || '/';
  // The latest sign-in function without re-running the effect when it changes.
  const signInRef = useRef(signInWithGoogleCredential);
  signInRef.current = signInWithGoogleCredential;
  const apiRef = useRef<GoogleIdApi | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const decide = () => oneTapDecision({
      clientId: GOOGLE_WEB_CLIENT_ID,
      signedIn: !!user,
      authLoading: loading,
      modalOpen: signInModalOpen,
      desktop: typeof window.matchMedia === 'function' && window.matchMedia(DESKTOP_QUERY).matches,
      pathname,
      dismissedAt: readDismissedAt(),
      askedThisSession: readAskedThisSession(),
      hasSignInParam: new URLSearchParams(window.location.search).has('signin'),
      now: Date.now(),
    });

    const withdraw = () => {
      try { apiRef.current?.cancel(); } catch { /* the card is already gone */ }
    };

    // A signed-in or modal-open state withdraws a card that is already up.
    if (!decide().ask) {
      if (user || signInModalOpen) withdraw();
      return;
    }

    timer = setTimeout(async () => {
      // Re-check after the wait: they may have signed in, opened the box or moved.
      if (cancelled || !decide().ask) return;
      const api = await loadGoogleIdentity();
      if (cancelled || !api || !decide().ask) return;
      apiRef.current = api;
      // One ask per session, spent when we actually ask.
      markAskedThisSession();
      let shownTracked = false;
      api.initialize({
        client_id: GOOGLE_WEB_CLIENT_ID,
        context: 'signin',
        auto_select: false,
        // Clicking around the page must not dismiss it, and must not count as a "no".
        cancel_on_tap_outside: false,
        itp_support: true,
        use_fedcm_for_prompt: true,
        callback: (response) => {
          if (!response?.credential) return;
          void signInRef.current(response.credential);
        },
      });
      api.prompt((notification) => {
        const outcome = readPromptOutcome(notification);
        if (!outcome) return;
        if (outcome.kind === 'shown') {
          if (!shownTracked) {
            shownTracked = true;
            trackUgc('sign_in_prompt_shown', { context: 'generic', source: ONE_TAP_SOURCE });
          }
          return;
        }
        if (outcome.kind === 'not_displayed') {
          trackUgc('one_tap_not_displayed', { reason: outcome.reason });
          return;
        }
        if (shouldCooldown(outcome)) {
          markDismissed();
          trackUgc('sign_in_prompt_dismissed', { context: 'generic', source: ONE_TAP_SOURCE });
        }
      });
    }, ONE_TAP_DELAY_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [user, loading, signInModalOpen, pathname]);

  return null;
}
