'use client';

import { Component, lazy, type ComponentType, type ReactNode } from 'react';

/**
 * A React.lazy component that can be preloaded and retried (BRO-7494).
 *
 * - `preload()` starts the chunk download early (pointerdown / hover / focus on
 *   the button that opens it), so the first tap on a slow network isn't blank.
 * - `reset()` swaps in a fresh lazy wrapper after a failed load. React.lazy
 *   caches a rejected import forever, so without this a single flaky request
 *   would break the panel until a full page reload.
 * - `get()` returns the current wrapper; read it during render.
 */
export interface LazyChunk<P> {
  get: () => ComponentType<P>;
  preload: () => void;
  reset: () => void;
}

export function createLazyChunk<P>(
  loader: () => Promise<{ default: ComponentType<P> }>,
): LazyChunk<P> {
  let current = lazy(loader);
  return {
    get: () => current,
    // webpack caches a successful chunk and retries a failed one on the next
    // import(), so calling this on every pointerdown/hover is cheap. Swallow the
    // rejection here: the real render path reports it via LazyChunkBoundary.
    preload: () => { loader().catch(() => {}); },
    reset: () => { current = lazy(loader); },
  };
}

/**
 * Local error boundary for anything loaded with lazy()/next/dynamic. A failed
 * chunk load (or any render error inside it) renders `fallback` (default:
 * nothing) and calls `onError`, instead of bubbling to src/app/error.tsx and
 * replacing the whole page. For a panel or sheet, `onError` should close it and
 * tell the user. scripts/tests guard: tests/unit/lazy-chunk-boundary.test.mjs
 * fails on a lazy()/dynamic() component rendered without one.
 */
export class LazyChunkBoundary extends Component<
  { children: ReactNode; onError?: (error: unknown) => void; fallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) {
    console.error('[lazy-chunk] panel failed to load', error);
    // These used to surface as a page crash (src/app/error.tsx reports those);
    // report them here so a real render bug inside a lazy panel isn't silenced.
    try {
      window.Sentry?.captureException?.(error, { tags: { error_boundary: 'lazy-chunk' } });
    } catch {
      // never throw from a boundary
    }
    this.props.onError?.(error);
  }
  render() { return this.state.failed ? (this.props.fallback ?? null) : this.props.children; }
}

export const LAZY_PANEL_ERROR_MESSAGE = 'Couldn’t open that. Check your connection and try again.';
