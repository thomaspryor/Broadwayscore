'use client';

import { useState, useEffect, useRef, useCallback, useMemo, useDeferredValue } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type Fuse from 'fuse.js';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useCurrentMarket } from '@/hooks/useCurrentMarket';
import { captureEvent } from '@/lib/posthog-events';
import { gaEvent } from '@/lib/analytics/ga-event';
import { getRegionalLabel } from '@/lib/market-utils';
import {
  mergeSearchResults, suggestCloseMatches, createSuggestionIndex, withHeaderSearchExtra, HEADER_FUSE_OPTIONS,
} from '../../scripts/lib/show-search-match';

interface Show {
  id: string;
  title: string;
  slug: string;
  status: string;
  venue?: string;
  creativeTeamNames?: string;
  akaTitles?: string[];
  images?: {
    thumbnail?: string;
  };
  hasScore?: boolean;
  category?: string;
  castNames?: string;
  archived?: boolean;
  year?: string;
}

export default function HeaderSearch() {
  const [shows, setShows] = useState<Show[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const fetchedRef = useRef(false);
  const fuseRef = useRef<Fuse<Show> | null>(null);
  const suggestionIndexRef = useRef<ReturnType<typeof createSuggestionIndex> | null>(null);
  const [dataReady, setDataReady] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const marketId = useCurrentMarket();
  const browseHref = marketId === 'west-end' ? '/west-end' : marketId === 'off-west-end' ? '/off-west-end' : marketId === 'off-broadway' ? '/off-broadway' : '/';
  const searchLabel = marketId === 'west-end' || marketId === 'off-west-end' ? 'Search West End shows' : marketId === 'off-broadway' ? 'Search Off-Broadway shows' : 'Search Broadway shows';

  // Fetch search data + Fuse.js on first interaction (both lazy-loaded)
  const ensureData = useCallback(async () => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    setIsLoading(true);
    try {
      const [res, extraRes, { default: FuseClass }] = await Promise.all([
        fetch('/data/search-shows.json'),
        // Cast names + unscored closed shows (BRO-4225, BRO-3628). Optional:
        // search still works on the main index if this fails.
        fetch('/data/header-search-extra.json').catch(() => null),
        import('fuse.js/basic') as Promise<{ default: typeof Fuse }>,
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let data: Show[] = await res.json();
      if (extraRes?.ok) {
        try {
          data = withHeaderSearchExtra(data, await extraRes.json()) as Show[];
        } catch { /* keep the main index */ }
      }
      suggestionIndexRef.current = createSuggestionIndex(FuseClass, data);
      // Archived (unscored closed) shows stay out of the fuzzy index so they
      // can't take its 8 slots from live shows; they are still found by exact
      // title substring and by typo fixes in mergeSearchResults.
      fuseRef.current = new FuseClass(data.filter(show => !show.archived), HEADER_FUSE_OPTIONS);
      setShows(data);
      setDataReady(true);
    } catch {
      fetchedRef.current = false; // allow retry on next interaction
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Filter shows based on deferred query — keeps typing responsive while search catches up
  const filteredShows = useMemo(() => {
    if (deferredQuery.length < 1 || !fuseRef.current) return [];
    const fuseResults = fuseRef.current.search(deferredQuery, { limit: 8 });
    // Adds exact title, cast-name and whole-word venue/creator matches Fuse
    // can miss, then orders playing/upcoming, closed-scored, unscored archive
    // (stable). With none of those, confident typo fixes ("fleabg" -> Fleabag,
    // archive included) lead the list ahead of Fuse's fuzzy noise (BRO-3628).
    const closeMatches = () => (deferredQuery.trim().length >= 3 && suggestionIndexRef.current
      ? suggestCloseMatches(suggestionIndexRef.current, deferredQuery, 3) : []);
    return mergeSearchResults(shows, deferredQuery, fuseResults, 8, closeMatches) as Show[] & { confident?: boolean };
  }, [deferredQuery, dataReady, shows]);

  const closeSearch = useCallback(() => { setIsOpen(false); setIsMobileOpen(false); }, []);
  useClickOutside(containerRef, closeSearch);

  // Fire search_performed after 1s of no typing (≥2 chars).
  // Query text is captured ONLY on searches we failed: zero results, or only
  // Fuse's fuzzy guesses (no title, cast, venue/creator or typo-fix match, `confident` false) — these reveal
  // shows we may be missing (surfaced as Notion cards by
  // posthog-friction-analyzer.js). Searches that match real shows stay term-less
  // (privacy: don't log what users browse, only what we failed to return).
  // "True" zero-result requires the search index to be loaded (dataReady) AND
  // results to reflect the CURRENT query (query === deferredQuery) — otherwise a
  // not-yet-loaded or lagging index would report a real show as zero-results and
  // leak its term. has_results stays raw for the existing result-rate metric.
  useEffect(() => {
    if (query.length < 2) return;
    const timer = setTimeout(() => {
      const hasResults = filteredShows.length > 0;
      const missed = dataReady && query === deferredQuery && !filteredShows.confident;
      captureEvent('search_performed', {
        results_count: filteredShows.length,
        has_results: hasResults,
        ...(missed && hasResults ? { fuzzy_only: true } : {}),
        ...(missed ? { query: query.trim().slice(0, 120) } : {}),
      });
      // Keep free-text queries out of GA4: visitors can type contact details.
      gaEvent('search_performed', {
        results_count: filteredShows.length,
        has_results: hasResults,
        ...(missed && hasResults ? { fuzzy_only: true } : {}),
      });
    }, 1000);
    return () => clearTimeout(timer);
  }, [query, deferredQuery, filteredShows, dataReady]);

  // Handle keyboard navigation — guard Enter against stale deferred results
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isOpen || filteredShows.length === 0) {
      if (e.key === 'Enter' && query.length > 0 && query === deferredQuery) {
        if (filteredShows.length > 0) {
          router.push(`/show/${filteredShows[0].slug}`);
          setIsOpen(false);
          setQuery('');
        }
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev =>
          prev < filteredShows.length - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => prev > 0 ? prev - 1 : -1);
        break;
      case 'Enter':
        e.preventDefault();
        if (query !== deferredQuery) break; // wait for results to catch up
        if (selectedIndex >= 0 && selectedIndex < filteredShows.length) {
          router.push(`/show/${filteredShows[selectedIndex].slug}`);
          setIsOpen(false);
          setQuery('');
          setSelectedIndex(-1);
        } else if (filteredShows.length > 0) {
          router.push(`/show/${filteredShows[0].slug}`);
          setIsOpen(false);
          setQuery('');
        }
        break;
      case 'Escape':
        setIsOpen(false);
        setSelectedIndex(-1);
        break;
    }
  }, [isOpen, filteredShows, selectedIndex, router, query, deferredQuery]);

  // selectedIndex is reset inline in onChange handlers to avoid a second render per keystroke

  const handleResultClick = (slug: string) => {
    captureEvent('search_selected', {
      show_id: slug,
      results_count: filteredShows.length,
    });
    gaEvent('search_selected', {
      show_id: slug,
      results_count: filteredShows.length,
    });
    router.push(`/show/${slug}`);
    setIsOpen(false);
    setIsMobileOpen(false);
    setQuery('');
    setSelectedIndex(-1);
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Desktop search input */}
      <div className="hidden lg:block relative">
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(-1);
              setIsOpen(e.target.value.length >= 1);
            }}
            onFocus={() => { ensureData(); query.length >= 1 && setIsOpen(true); }}
            onKeyDown={handleKeyDown}
            placeholder="Search shows..."
            className="w-56 px-3 py-1.5 pl-9 text-sm bg-white/5 border border-white/10 rounded-lg
                       text-white placeholder-fg-placeholder
                       focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand/50
                       transition-all duration-200"
            aria-label={searchLabel}
            role="combobox"
            aria-expanded={isOpen && filteredShows.length > 0}
            aria-haspopup="listbox"
            aria-controls="search-results"
            aria-autocomplete="list"
          />
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          {query && (
            <button
              onClick={() => {
                setQuery('');
                setIsOpen(false);
                inputRef.current?.focus();
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-white"
              aria-label="Clear search"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Desktop dropdown */}
        {isOpen && filteredShows.length > 0 && (
          <div
            id="search-results"
            role="listbox"
            className="absolute top-full right-0 mt-2 w-80 bg-surface-raised border border-white/10 rounded-lg shadow-xl overflow-hidden z-[80]"
          >
            {filteredShows.map((show, index) => (
              <button
                key={show.id}
                role="option"
                aria-selected={index === selectedIndex}
                onClick={() => handleResultClick(show.slug)}
                className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors
                           ${index === selectedIndex ? 'bg-white/10' : 'hover:bg-white/5'}`}
              >
                {show.images?.thumbnail ? (
                  <img
                    src={show.images.thumbnail}
                    alt={show.title}
                    className="w-10 h-10 rounded object-cover flex-shrink-0"
                  />
                ) : (
                  <div className="w-10 h-10 rounded bg-white/10 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white truncate">{show.title}</div>
                  <div className="text-xs text-gray-400 flex items-center gap-2">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium
                                    ${show.status === 'open' ? 'bg-green-500/20 text-green-400' :
                                      show.status === 'previews' ? 'bg-yellow-500/20 text-yellow-400' :
                                      show.status === 'upcoming' || show.status === 'announced' ? 'bg-blue-500/20 text-blue-400' :
                                      'bg-gray-500/20 text-gray-400'}`}>
                      {show.status === 'open' ? 'Now Playing' :
                       show.status === 'previews' ? 'In Previews' :
                       show.status === 'upcoming' ? 'Upcoming' :
                       show.status === 'announced' ? 'Announced' : 'Closed'}
                    </span>
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      show.category === 'west-end' ? 'bg-teal-500/20 text-teal-400' :
                      show.category === 'off-west-end' ? 'bg-violet-500/20 text-violet-400' :
                      show.category === 'off-broadway' ? 'bg-indigo-500/20 text-indigo-400' :
                      show.category === 'regional' ? 'bg-emerald-500/20 text-emerald-400' :
                      show.category === 'tour' ? 'bg-sky-500/20 text-sky-400' :
                      'bg-blue-500/20 text-blue-400'
                    }`}>
                      {show.category === 'west-end' ? 'West End' :
                       show.category === 'off-west-end' ? 'Off-West End' :
                       show.category === 'off-broadway' ? 'Off-Bway' :
                       show.category === 'regional' ? getRegionalLabel(show) :
                       show.category === 'tour' ? 'Tour' : 'Broadway'}
                    </span>
                    {show.venue ? <span className="truncate">{show.venue}</span> : show.year ? <span>{show.year}</span> : null}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* No results message */}
        {isOpen && deferredQuery.length >= 1 && filteredShows.length === 0 && (
          <div className="absolute top-full right-0 mt-2 w-80 bg-surface-raised border border-white/10 rounded-lg shadow-xl p-4 z-[80]">
            {isLoading ? (
              <p className="text-sm text-gray-400 text-center">Loading...</p>
            ) : (
              <NoResults query={query} onLink={closeSearch} browseHref={browseHref} />
            )}
          </div>
        )}
      </div>

      {/* Mobile search button */}
      <button
        onClick={() => { ensureData(); setIsMobileOpen(true); }}
        className="lg:hidden p-1.5 text-gray-400 hover:text-white transition-colors"
        aria-label="Search shows"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </button>

      {/* Mobile search overlay */}
      {isMobileOpen && (
        <div className="fixed inset-0 z-[100] bg-surface lg:hidden">
          <div className="flex flex-col h-full">
            <div className="flex items-center gap-3 p-4 border-b border-white/10">
              <button
                onClick={() => {
                  setIsMobileOpen(false);
                  setQuery('');
                }}
                className="p-2 -ml-2 text-gray-400 hover:text-white"
                aria-label="Close search"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <div className="flex-1 relative">
                <input
                  type="text"
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setSelectedIndex(-1); }}
                  onKeyDown={handleKeyDown}
                  placeholder={`${searchLabel}...`}
                  className="w-full px-4 py-2 pl-10 text-base bg-white/5 border border-white/10 rounded-lg
                             text-white placeholder-fg-placeholder
                             focus:outline-none focus:ring-2 focus:ring-brand/50"
                  autoFocus
                />
                <svg
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
            </div>

            {/* Mobile results */}
            <div className="flex-1 overflow-y-auto">
              {filteredShows.length > 0 ? (
                <div className="divide-y divide-white/5">
                  {filteredShows.map((show) => (
                    <button
                      key={show.id}
                      onClick={() => handleResultClick(show.slug)}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors"
                    >
                      {show.images?.thumbnail ? (
                        <img
                          src={show.images.thumbnail}
                          alt={show.title}
                          className="w-12 h-12 rounded object-cover flex-shrink-0"
                        />
                      ) : (
                        <div className="w-12 h-12 rounded bg-white/10 flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0 text-left">
                        <div className="text-base font-medium text-white truncate">{show.title}</div>
                        <div className="text-sm text-gray-400 flex items-center gap-2 mt-0.5">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium
                                          ${show.status === 'open' ? 'bg-green-500/20 text-green-400' :
                                            show.status === 'previews' ? 'bg-yellow-500/20 text-yellow-400' :
                                            show.status === 'upcoming' || show.status === 'announced' ? 'bg-blue-500/20 text-blue-400' :
                                            'bg-gray-500/20 text-gray-400'}`}>
                            {show.status === 'open' ? 'Now Playing' :
                             show.status === 'previews' ? 'In Previews' :
                             show.status === 'upcoming' ? 'Upcoming' :
                             show.status === 'announced' ? 'Announced' : 'Closed'}
                          </span>
                          {show.category === 'west-end' && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-teal-500/20 text-teal-400">West End</span>
                          )}
                          {show.category === 'off-west-end' && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-violet-500/20 text-violet-400">Off-West End</span>
                          )}
                          {show.category === 'off-broadway' && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-indigo-500/20 text-indigo-400">Off-Bway</span>
                          )}
                          {show.venue ? <span className="truncate">{show.venue}</span> : show.year ? <span>{show.year}</span> : null}
                        </div>
                      </div>
                      <svg className="w-5 h-5 text-fg-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  ))}
                </div>
              ) : deferredQuery.length >= 1 ? (
                <div className="p-6">
                  {isLoading ? (
                    <p className="text-gray-400 text-center">Loading...</p>
                  ) : (
                    <NoResults query={query} onLink={() => { closeSearch(); setQuery(''); }} browseHref={browseHref} large />
                  )}
                </div>
              ) : (
                <div className="p-8 text-center">
                  <p className="text-gray-400">Type to search for shows</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Zero-result state: a way forward instead of a dead end (BRO-3628). */
function NoResults({ query, onLink, browseHref, large = false }: {
  query: string;
  onLink: () => void;
  browseHref: string;
  large?: boolean;
}) {
  const text = large ? 'text-base' : 'text-sm';
  return (
    <div className={text}>
      <p className="text-gray-400 text-center">No shows found for &ldquo;{query}&rdquo;</p>
      <p className="mt-3 text-xs text-gray-400 text-center">
        Try a show title or a performer&rsquo;s name, or{' '}
        <Link href={browseHref} onClick={onLink} className="text-brand hover:text-brand-hover">browse all shows</Link>.
        {' '}Missing a show?{' '}
        <Link href="/feedback" onClick={onLink} className="text-brand hover:text-brand-hover">Tell us</Link>.
      </p>
    </div>
  );
}
