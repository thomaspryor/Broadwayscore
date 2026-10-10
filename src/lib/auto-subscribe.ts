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
 *
 * Cross-page guard: the OAuth return page (/auth/complete) calls this, then
 * full-page navigates ~100ms later. The POST reaches Formspree but the page
 * dies before reading the response, so the subscribed flag was never written
 * and the next page posted again: one duplicate Formspree email per Google
 * sign-in (2026-10-09). A localStorage in-flight stamp, written BEFORE the
 * fetch, now survives that navigation, and keepalive lets the request finish.
 */

import { isFormspreeSubscribed, SUBSCRIBED_KEY_PREFIX } from '@/hooks/useFormspreeSubscribed';

const FORM_ID = process.env.NEXT_PUBLIC_FORMSPREE_SUBSCRIBER_FORM_ID || '';

export const INFLIGHT_KEY = 'bsc_autosub_inflight';
const INFLIGHT_TTL_MS = 10 * 60 * 1000;

let attemptedThisSession = false;

function inflightRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(INFLIGHT_KEY));
    return at > 0 && Date.now() - at < INFLIGHT_TTL_MS;
  } catch { return false; }
}

function setInflight(on: boolean): void {
  try {
    if (on) localStorage.setItem(INFLIGHT_KEY, String(Date.now()));
    else localStorage.removeItem(INFLIGHT_KEY);
  } catch { /* localStorage unavailable — module guard still applies */ }
}

export async function autoSubscribeOnSignIn(email: string): Promise<void> {
  if (!FORM_ID || !email || attemptedThisSession) return;
  // Synthetic accounts from the automated signed-in E2E (minted via GoTrue
  // admin, injected into bsc_auth) must never reach the real subscriber
  // pipeline — every test run would add a junk email to the list.
  if (email.endsWith('@bsc-test.dev')) return;
  // Check the broadway (main) list SPECIFICALLY — a WE-only subscriber who
  // signs in still belongs on the main list (owner rule: sign-in = main list).
  if (isFormspreeSubscribed('broadway')) return;
  // A previous page already sent this and navigated away before the reply.
  if (inflightRecently()) return;
  attemptedThisSession = true;
  setInflight(true);

  try {
    const res = await fetch(`https://formspree.io/f/${FORM_ID}`, {
      method: 'POST',
      keepalive: true,
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
      setInflight(false);
      return;
    }
    try {
      localStorage.setItem(`${SUBSCRIBED_KEY_PREFIX}broadway`, 'true');
      localStorage.removeItem(INFLIGHT_KEY);
      window.dispatchEvent(new Event('bsc_subscribed'));
    } catch { /* localStorage unavailable — gate still holds via auth */ }
  } catch {
    attemptedThisSession = false;
    setInflight(false);
  }
}

/** Test seam: reset the per-page guard, as a full-page navigation does. */
export function __resetForNewPage(): void {
  attemptedThisSession = false;
}
