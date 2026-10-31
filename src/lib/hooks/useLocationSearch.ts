'use client';

import { useSyncExternalStore } from 'react';

// window.location.search as React state, without useSearchParams().
//
// On a static export useSearchParams() bails its nearest Suspense boundary
// out to client-side rendering, so the prerendered HTML ships an empty hole
// (BRO-4597 show hero, BRO-4600 home + market grids). The server snapshot is
// '' (no filters), so the HTML carries the default grid; React re-renders
// with the real query right after hydration.
//
// URL writes that this hook must see go through replaceLocationSearch().

const CHANGE_EVENT = 'bsc:location-search';

function subscribe(onChange: () => void) {
  window.addEventListener('popstate', onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

const getSnapshot = () => window.location.search;
const getServerSnapshot = () => '';

export function useLocationSearch(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Replace the current URL (no navigation) and notify useLocationSearch().
 * Pass a fresh state object: Next's patched replaceState skips its router sync
 * when the state already carries its __NA marker, and a stale router URL lets
 * Next's HistoryUpdater rewrite this change away later.
 */
export function replaceLocationSearch(url: string) {
  window.history.replaceState({}, '', url);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
