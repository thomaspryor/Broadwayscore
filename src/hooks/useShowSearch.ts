import { useState, useRef, useCallback, useMemo, useDeferredValue } from 'react';
import type Fuse from 'fuse.js';
import { mergeDiaryShows, tierSearchResults, type DiarySearchEntry } from '@/lib/show-import';

interface SearchShow {
  id: string;
  title: string;
  venue?: string;
}

interface UseShowSearchOptions {
  /** Fuse.js key weights (default: title 0.8, venue 0.2) */
  keys?: Array<{ name: string; weight: number }>;
  /** Max results to return (default: 6) */
  limit?: number;
  /** Data URL (default: /data/search-shows.json) */
  dataUrl?: string;
  /** Whether to eagerly load data on mount (default: false — loads on first call to ensureData) */
  eager?: boolean;
  /** Optional second dataset (e.g. /data/diary-search.json) merged into the
   *  base catalog via mergeDiaryShows before the Fuse index is built. */
  mergeDataUrl?: string;
}

const DEFAULT_KEYS = [
  { name: 'title', weight: 0.8 },
  { name: 'venue', weight: 0.2 },
];

/**
 * Shared hook for lazy-loaded show search with Fuse.js.
 * Handles data fetching, Fuse initialization, deferred query filtering,
 * and substring fallback — all in one place.
 *
 * Used by HeaderSearch, AddShowSearch (MyShowsClient), ListAddShowSearch (ListsTab).
 */
export function useShowSearch<T extends SearchShow = SearchShow>(options: UseShowSearchOptions = {}) {
  const { keys = DEFAULT_KEYS, limit = 6, dataUrl = '/data/search-shows.json', mergeDataUrl } = options;

  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [shows, setShows] = useState<T[]>([]);
  const [dataReady, setDataReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const fuseRef = useRef<Fuse<T> | null>(null);
  const fetchedRef = useRef(false);

  const ensureData = useCallback(async () => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    setIsLoading(true);
    try {
      const [res, mergeRes, { default: FuseClass }] = await Promise.all([
        fetch(dataUrl),
        mergeDataUrl ? fetch(mergeDataUrl).catch(() => null) : Promise.resolve(null),
        import('fuse.js/basic') as Promise<{ default: typeof Fuse }>,
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let data: T[] = await res.json();
      if (mergeRes?.ok) {
        try {
          const mergeData: DiarySearchEntry[] = await mergeRes.json();
          data = mergeDiaryShows(data, mergeData);
        } catch { /* ignore parse errors — base data still usable */ }
      }
      fuseRef.current = new FuseClass(data, {
        keys,
        threshold: 0.35,
        ignoreLocation: true,
        minMatchCharLength: 2,
      });
      setShows(data);
      setDataReady(true);
    } catch {
      fetchedRef.current = false; // allow retry
    } finally {
      setIsLoading(false);
    }
  }, [dataUrl, mergeDataUrl, keys]);

  const results = useMemo(() => {
    if (deferredQuery.length < 2 || !fuseRef.current) return [];
    // In diary-tiering mode, the diary catalog outnumbers scored shows ~20:1,
    // so a Fuse window capped at `limit` could fill entirely with diary fuzzy
    // matches and silently exclude a scored show that would otherwise win
    // the tier sort. Search a wider window, then tier, then trim to `limit`.
    const searchLimit = mergeDataUrl ? Math.max(limit * 5, 30) : limit;
    const fuseResults = fuseRef.current.search(deferredQuery, { limit: searchLimit }).map(r => r.item);
    const q = deferredQuery.toLowerCase();
    const substring = shows.filter(s =>
      s.title.toLowerCase().includes(q) && !fuseResults.some(r => r.id === s.id)
    );
    const combined = [...fuseResults, ...substring];
    // Only the diary-merged index (mergeDataUrl set) carries a `dy` field —
    // header/site search never opts in, so this is a no-op there.
    return mergeDataUrl ? tierSearchResults(combined, limit) : combined.slice(0, limit);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredQuery, dataReady, shows, limit, mergeDataUrl]);

  return {
    query,
    setQuery,
    results,
    shows,
    ensureData,
    dataReady,
    isLoading,
  };
}
