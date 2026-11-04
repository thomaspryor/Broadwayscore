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
 *
 * The stamp has no expiry. A failed post clears it, so a stamp still present
 * on a later page means the post went out and its page closed before the
 * reply: that counts as joined. A 10-minute expiry let the next page load
 * after it post again (2026-10-12: second emails 10.5 min and 2 h after
 * /auth/complete).
 */

import { isFormspreeSubscribed, SUBSCRIBED_KEY_PREFIX } from '@/hooks/useFormspreeSubscribed';
import { buildSignupBody } from '@/lib/signup-city';

const FORM_ID = process.env.NEXT_PUBLIC_FORMSPREE_SUBSCRIBER_FORM_ID || '';

export const INFLIGHT_KEY = 'bsc_autosub_inflight';
/*
 * Critic sign-ins skip the mailing list (owner 2026-11-04): the critic popup
 * promises "we won't add you to any mailing list".
 * - SKIP_KEY: a critic sign-in attempt is in progress (timestamp; expires after
 *   PENDING_MS and is cleared when the popup is dismissed, another sign-in
 *   starts, or the user signs out), so a reader who only peeks at Claim still
 *   joins the list on a later normal sign-in.
 * - SKIP_USER_KEY: the signed-in critic's id, kept until their account records
 *   no_autosub (user_metadata), so a failed write is retried and never lost.
 * - user_metadata.no_autosub: the durable, cross-device record.
 */
export const SKIP_KEY = 'bsc_autosub_skip';
export const SKIP_USER_KEY = 'bsc_autosub_skip_user';
// 15 min: long enough to open the magic link, short enough that a shared
// device's next person is not caught by an earlier critic's attempt.
const PENDING_MS = 15 * 60 * 1000;

export function markCriticSignInStarted(now: number = Date.now()): void {
  try { localStorage.setItem(SKIP_KEY, String(now)); } catch { /* storage unavailable */ }
}

export function clearCriticSignInStarted(): void {
  try { localStorage.removeItem(SKIP_KEY); } catch { /* storage unavailable */ }
}

export function criticSignInPending(now: number = Date.now()): boolean {
  try {
    const t = Number(localStorage.getItem(SKIP_KEY));
    return t > 0 && now - t < PENDING_MS;
  } catch { return false; }
}

export interface AutoSubscribeUser {
  id?: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
}

/** The one rule for whether this signed-in user skips the mailing list. */
export function shouldSkipAutoSubscribe(u: AutoSubscribeUser, now: number = Date.now()): boolean {
  if (u.user_metadata?.no_autosub === true) return true;
  if (criticSignInPending(now)) return true;
  try { return !!u.id && localStorage.getItem(SKIP_USER_KEY) === u.id; } catch { return false; }
}

/**
 * What the account still needs: 'record' when a critic sign-in just finished
 * (or an earlier record failed) and the account lacks no_autosub. Moving the
 * pending attempt onto the user id here means it no longer depends on expiry.
 */
export function criticOptOutToRecord(u: AutoSubscribeUser, now: number = Date.now()): boolean {
  if (u.user_metadata?.no_autosub === true) {
    try { localStorage.removeItem(SKIP_USER_KEY); localStorage.removeItem(SKIP_KEY); } catch { /* */ }
    return false;
  }
  if (!u.id) return false;
  if (criticSignInPending(now)) {
    try { localStorage.setItem(SKIP_USER_KEY, u.id); localStorage.removeItem(SKIP_KEY); } catch { /* */ }
    return true;
  }
  try { return localStorage.getItem(SKIP_USER_KEY) === u.id; } catch { return false; }
}

export function markCriticOptOutRecorded(): void {
  try { localStorage.removeItem(SKIP_USER_KEY); } catch { /* storage unavailable */ }
}

let attemptedThisSession = false;

function markJoined(): void {
  try {
    localStorage.setItem(`${SUBSCRIBED_KEY_PREFIX}broadway`, 'true');
    localStorage.removeItem(INFLIGHT_KEY);
    window.dispatchEvent(new Event('bsc_subscribed'));
  } catch { /* localStorage unavailable — gate still holds via auth */ }
}

/** True when an earlier page sent the post and closed before reading the reply. */
function sentByEarlierPage(): boolean {
  try {
    return Number(localStorage.getItem(INFLIGHT_KEY)) > 0;
  } catch { return false; }
}

function setInflight(on: boolean): void {
  try {
    if (on) localStorage.setItem(INFLIGHT_KEY, String(Date.now()));
    else localStorage.removeItem(INFLIGHT_KEY);
  } catch { /* localStorage unavailable — module guard still applies */ }
}

export async function autoSubscribeOnSignIn(email: string, user: AutoSubscribeUser = {}): Promise<void> {
  if (!FORM_ID || !email || attemptedThisSession) return;
  // Synthetic accounts from the automated signed-in E2E (minted via GoTrue
  // admin, injected into bsc_auth) must never reach the real subscriber
  // pipeline — every test run would add a junk email to the list.
  if (email.endsWith('@bsc-test.dev')) return;
  if (shouldSkipAutoSubscribe(user)) return;
  // Check the broadway (main) list SPECIFICALLY — a WE-only subscriber who
  // signs in still belongs on the main list (owner rule: sign-in = main list).
  if (isFormspreeSubscribed('broadway')) return;
  // A previous page already sent this and navigated away before the reply.
  if (sentByEarlierPage()) { markJoined(); return; }
  attemptedThisSession = true;
  setInflight(true);

  try {
    const res = await fetch(`https://formspree.io/f/${FORM_ID}`, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSignupBody({
        email,
        source: 'auth-auto',
        market: 'broadway',
        page: typeof window !== 'undefined' ? window.location.pathname : '/',
        pathname: typeof window !== 'undefined' ? window.location.pathname : '/',
        isSubscriber: true,
      })),
    });
    if (!res.ok) {
      // Leave flags unset — a later sign-in retries. Popups are still
      // suppressed for this user via the isAuthenticated gate.
      attemptedThisSession = false;
      setInflight(false);
      return;
    }
    markJoined();
  } catch {
    attemptedThisSession = false;
    setInflight(false);
  }
}

/** Test seam: reset the per-page guard, as a full-page navigation does. */
export function __resetForNewPage(): void {
  attemptedThisSession = false;
}
