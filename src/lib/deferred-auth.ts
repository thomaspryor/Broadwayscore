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

export function saveReturnUrl(url?: string): void {
  try {
    localStorage.setItem(RETURN_URL_KEY, url || window.location.pathname);
  } catch {
    // localStorage not available
  }
}

export function getReturnUrl(): string {
  try {
    return localStorage.getItem(RETURN_URL_KEY) || '/';
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
