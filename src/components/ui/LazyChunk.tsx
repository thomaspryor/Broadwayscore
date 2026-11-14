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
 * Local error boundary for a lazily loaded panel or sheet. A failed chunk load
 * (or any render error inside it) renders nothing and calls `onError`, which
 * should close the panel and tell the user, instead of bubbling to
 * src/app/error.tsx and replacing the whole show page.
 */
export class LazyChunkBoundary extends Component<
  { children: ReactNode; onError: (error: unknown) => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) {
    console.error('[lazy-chunk] panel failed to load', error);
    this.props.onError(error);
  }
  render() { return this.state.failed ? null : this.props.children; }
}

export const LAZY_PANEL_ERROR_MESSAGE = 'Couldn’t open that. Check your connection and try again.';
