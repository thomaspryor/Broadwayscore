/**
 * Recover from a stale tab after a deploy (BRO-5565).
 *
 * Production deploys every few hours. A tab opened before one still runs the
 * old webpack runtime; the next click fetches the new page's chunks, the old
 * runtime finds no module factory for them and throws
 * "Cannot read properties of undefined (reading 'call')" (Safari: "undefined is
 * not an object (evaluating 'd[e].call')"). The click silently does nothing and
 * every later click does the same until the visitor reloads by hand: 100+
 * Sentry events across five issues, 10+ visitors in two weeks.
 *
 * A reload fetches the current build. It runs at most once per window so a
 * genuine bug with this message can never loop.
 */
import { isAuthCallbackPath } from './analytics/redact-url';

export const STALE_RELOAD_KEY = 'bsc_stale_deploy_reload_at';
export const STALE_RELOAD_WINDOW_MS = 5 * 60_000;

// The missing-module throw: Chrome/Edge ("reading 'call'"), Safari
// ("evaluating 'd[e].call'") and Firefox ("e[o] is undefined"). Minified names
// may contain $.
const MISSING_MODULE = /reading 'call'|evaluating '[\w$]+\[[\w$]+\]\.call'|[\w$]+\[[\w$]+\] is undefined/;
// A chunk the new build no longer serves.
const CHUNK_GONE = /ChunkLoadError|Loading chunk \S+ failed|Loading CSS chunk \S+ failed/;

/** True for the errors a post-deploy tab throws; false for any other bug. */
export function isStaleDeployError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { name, message, stack } = err as { name?: unknown; message?: unknown; stack?: unknown };
  const text = `${typeof name === 'string' ? name : ''}: ${typeof message === 'string' ? message : ''}`;
  if (CHUNK_GONE.test(text)) return true;
  // The same wording appears for ordinary bugs, so require the webpack runtime
  // chunk in the stack.
  return MISSING_MODULE.test(text) && typeof stack === 'string' && /_next\/static\/chunks\/webpack/.test(stack);
}

interface ReloadDeps {
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  now?: number;
  reload?: () => void;
  pathname?: string;
  /** Runs just before the reload, e.g. to count it. */
  onReload?: () => void;
  /** Overrides the "is the visitor typing" check (tests). */
  typing?: boolean;
}

/** A reload would throw away what the visitor is typing right now. */
function isTyping(): boolean {
  const el = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && !/^(button|submit|checkbox|radio|reset|image|range|color)$/i.test((el as HTMLInputElement).type);
}

/** Reload once per window. Returns whether it reloaded. */
export function reloadOnStaleDeploy(deps: ReloadDeps = {}): boolean {
  if (typeof window === 'undefined') return false;
  const pathname = deps.pathname ?? window.location.pathname;
  // The OAuth return pages carry live tokens in their hash; never reload them.
  if (isAuthCallbackPath(pathname)) return false;
  if (deps.typing ?? isTyping()) return false;
  const now = deps.now ?? Date.now();
  try {
    const storage = deps.storage === undefined ? window.sessionStorage : deps.storage;
    if (!storage) return false;
    const last = Number(storage.getItem(STALE_RELOAD_KEY) || 0);
    if (now - last < STALE_RELOAD_WINDOW_MS) return false;
    storage.setItem(STALE_RELOAD_KEY, String(now));
  } catch {
    // No storage means no loop guard, so no reload.
    return false;
  }
  try { deps.onReload?.(); } catch { /* counting must never block the recovery */ }
  (deps.reload ?? (() => window.location.reload()))();
  return true;
}

/** Listen for the stale-deploy errors that never reach an error boundary. */
export function installStaleDeployReload(onReload?: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onError = (e: ErrorEvent) => { if (isStaleDeployError(e.error)) reloadOnStaleDeploy({ onReload }); };
  const onRejection = (e: PromiseRejectionEvent) => { if (isStaleDeployError(e.reason)) reloadOnStaleDeploy({ onReload }); };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
