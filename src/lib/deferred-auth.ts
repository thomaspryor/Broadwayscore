import type { PendingAction } from '@/types/user';

const PENDING_ACTION_KEY = 'bsc_pending_action';
const RETURN_URL_KEY = 'bsc_return_url';

/**
 * Deferred auth manager — handles the "invest then gate" flow.
 *
 * Flow:
 * 1. User rates a show (not signed in)
 * 2. savePendingAction() stores the rating in localStorage
 * 3. saveReturnUrl() stores current page URL
 * 4. Sign-in modal opens → user signs in
 * 5. Auth callback → redirect to return URL
 * 6. On auth success, getPendingAction() retrieves the rating
 * 7. Auto-save the rating, then clearPendingAction()
 */

export function savePendingAction(action: PendingAction): void {
  try {
    localStorage.setItem(PENDING_ACTION_KEY, JSON.stringify(action));
  } catch {
    // localStorage not available
  }
}

export function getPendingAction(): PendingAction | null {
  try {
    const stored = localStorage.getItem(PENDING_ACTION_KEY);
    if (!stored) return null;

    const action = JSON.parse(stored) as PendingAction;

    // Expire after 1 hour
    if (Date.now() - action.timestamp > 60 * 60 * 1000) {
      clearPendingAction();
      return null;
    }

    return action;
  } catch {
    return null;
  }
}

export function clearPendingAction(): void {
  try {
    localStorage.removeItem(PENDING_ACTION_KEY);
  } catch {
    // localStorage not available
  }
}

/**
 * Only same-site paths ("/show/x?tab=y"). Rejects "//evil.com", "/\\evil.com"
 * and absolute URLs, so the post-sign-in redirect can never leave the site.
 * Also rejects control characters: the URL parser strips tab/CR/LF, so
 * "/\t/evil.com" would otherwise navigate to "//evil.com".
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export function safeReturnPath(url: string | null | undefined): string {
  if (!url || !url.startsWith('/') || url.startsWith('//') || url.includes('\\') || CONTROL_CHARS.test(url)) return '/';
  return url;
}

export function saveReturnUrl(url?: string): void {
  try {
    const current = window.location.pathname + window.location.search;
    localStorage.setItem(RETURN_URL_KEY, safeReturnPath(url || current));
  } catch {
    // localStorage not available
  }
}

export function getReturnUrl(): string {
  try {
    return safeReturnPath(localStorage.getItem(RETURN_URL_KEY));
  } catch {
    return '/';
  }
}

export function clearReturnUrl(): void {
  try {
    localStorage.removeItem(RETURN_URL_KEY);
  } catch {
    // localStorage not available
  }
}

/**
 * `?signin=1` deep link (the account line in our emails, BRO-4893).
 * Returns the analytics source for the sign-in prompt, or null when the URL
 * doesn't ask for sign-in. `utm_source` (lowercase, hyphens -> _) names the email,
 * e.g. ?signin=1&utm_source=newsletter -> 'email_newsletter'.
 */
export function signInSourceFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get('signin') !== '1') return null;
  const utm = params.get('utm_source') || '';
  return /^[a-z0-9_-]{1,32}$/.test(utm) ? `email_${utm.replace(/-/g, '_')}` : 'email_link';
}

/**
 * Reads the `?signin=1` deep link and removes `signin` from the address bar,
 * so a reload, a shared link or the return from Google sign-in can't reopen
 * the modal. Keeps every other param (utm_* stay for analytics).
 */
export function takeSignInParam(): string | null {
  try {
    const source = signInSourceFromSearch(window.location.search);
    if (!source) return null;
    const url = new URL(window.location.href);
    url.searchParams.delete('signin');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    return source;
  } catch {
    return null;
  }
}
