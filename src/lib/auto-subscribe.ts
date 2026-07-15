/**
 * Auto-subscribe a signed-in user to the main (Broadway) mailing list.
 *
 * Owner decision 2026-07-13: creating an account = joining the main list, and
 * signed-in users must never see the email-capture pop-ups (ProGateContext
 * additionally hard-suppresses them on isAuthenticated).
 *
 * Route: same Formspree subscriber form every other capture surface uses, so
 * the submission flows into the existing Formspree → subscriber pipeline.
 * Source is tagged `auth-auto` for list auditing. Never touches broadcast
 * APIs (CLAUDE.md §17).
 *
 * Idempotency: skips when any market's subscribed flag is already set, and a
 * module-level guard stops repeat posts within a session (SIGNED_IN can fire
 * more than once). Re-posting the same email from a second device is harmless —
 * subscriber ingestion dedupes by email.
 */

import { isFormspreeSubscribed, SUBSCRIBED_KEY_PREFIX } from '@/hooks/useFormspreeSubscribed';

const FORM_ID = process.env.NEXT_PUBLIC_FORMSPREE_SUBSCRIBER_FORM_ID || '';

let attemptedThisSession = false;

export async function autoSubscribeOnSignIn(email: string): Promise<void> {
  if (!FORM_ID || !email || attemptedThisSession) return;
  // Synthetic accounts from the automated signed-in E2E (minted via GoTrue
  // admin, injected into bsc_auth) must never reach the real subscriber
  // pipeline — every test run would add a junk email to the list.
  if (email.endsWith('@bsc-test.dev')) return;
  // Check the broadway (main) list SPECIFICALLY — a WE-only subscriber who
  // signs in still belongs on the main list (owner rule: sign-in = main list).
  if (isFormspreeSubscribed('broadway')) return;
  attemptedThisSession = true;

  try {
    const res = await fetch(`https://formspree.io/f/${FORM_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email.toLowerCase().trim(),
        source: 'auth-auto',
        market: 'broadway',
        page: typeof window !== 'undefined' ? window.location.pathname : '/',
      }),
    });
    if (!res.ok) {
      // Leave flags unset — a later sign-in retries. Popups are still
      // suppressed for this user via the isAuthenticated gate.
      attemptedThisSession = false;
      return;
    }
    try {
      localStorage.setItem(`${SUBSCRIBED_KEY_PREFIX}broadway`, 'true');
      window.dispatchEvent(new Event('bsc_subscribed'));
    } catch { /* localStorage unavailable — gate still holds via auth */ }
  } catch {
    attemptedThisSession = false;
  }
}
