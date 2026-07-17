'use client';
// DO NOT add PostHog instrumentation here — this component is used exclusively
// for /my-shows list management (adding shows to lists), not public browse search.
// Search analytics belong in HeaderSearch.tsx.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useShowSearch } from '@/hooks/useShowSearch';
import { searchMezzanineCatalog, MEZZANINE_SEARCH_ERROR_COPY, type MezzanineCandidate } from '@/lib/mezzanine-search';

interface SearchShow {
  id: string;
  title: string;
  slug: string;
  status: string;
  venue?: string;
  od?: string;
  images?: { thumbnail?: string };
  category?: string;
  /** True for diary-only (unscored) catalog entries — no /show page, no critic score. */
  dy?: boolean;
}

interface ShowSearchDropdownProps {
  placeholder?: string;
  onSelect: (show: SearchShow) => void;
  onClose: () => void;
  renderAction: (show: SearchShow) => ReactNode;
  isDisabled?: (show: SearchShow) => boolean;
  align?: 'left' | 'right';
  autoFocus?: boolean;
  /** Also search the diary-only catalog (regional/international/historical
   *  shows with no critic score) — lazily merged in on first open. */
  includeDiary?: boolean;
  /** Offer a live Mezzanine catalog search when the local index finds
   *  nothing — for a show in neither the scored nor diary-only catalog
   *  (card 174, Phase 2 of the self-heal loop). Selecting a live result
   *  calls onLiveSelect instead of onSelect (the caller owns writing the
   *  stub row and injecting it into local state). */
  enableLiveLookup?: boolean;
  onLiveSelect?: (candidate: MezzanineCandidate) => void;
}

type LiveLookupState = 'idle' | 'searching' | 'results' | 'error' | 'empty';

export default function ShowSearchDropdown({
  placeholder = 'Search to add...',
  onSelect,
  onClose,
  renderAction,
  isDisabled,
  align = 'left',
  autoFocus = true,
  includeDiary = false,
  enableLiveLookup = false,
  onLiveSelect,
}: ShowSearchDropdownProps) {
  const { query, setQuery, results, ensureData } = useShowSearch<SearchShow>({
    mergeDataUrl: includeDiary ? '/data/diary-search.json' : undefined,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const [liveState, setLiveState] = useState<LiveLookupState>('idle');
  const [liveCandidates, setLiveCandidates] = useState<MezzanineCandidate[]>([]);
  const [liveError, setLiveError] = useState<string | null>(null);
  const liveQueryRef = useRef('');
  // Unlike local results (isDisabled/renderAction let the caller show its own
  // "Adding..." state), a live pick fires an uncontrolled onLiveSelect with
  // no built-in guard — track it here so a rapid double-click can't fire the
  // stub-write + add twice (ship-check finding).
  const [addingLiveId, setAddingLiveId] = useState<string | null>(null);

  // A fresh keystroke invalidates any live-search results shown for the
  // previous query — otherwise "Cocktail Magique" results would linger
  // under a query the user has since edited to something else.
  useEffect(() => {
    if (query !== liveQueryRef.current) { setLiveState('idle'); setAddingLiveId(null); }
  }, [query]);

  const runLiveSearch = async () => {
    liveQueryRef.current = query;
    setLiveState('searching');
    setLiveError(null);
    try {
      const candidates = await searchMezzanineCatalog(query);
      setLiveCandidates(candidates);
      setLiveState(candidates.length > 0 ? 'results' : 'empty');
    } catch (err) {
      setLiveError(err instanceof Error ? err.message : MEZZANINE_SEARCH_ERROR_COPY.internal);
      setLiveState('error');
    }
  };

  useEffect(() => {
    if (autoFocus) {
      ensureData();
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [autoFocus, ensureData]);

  return (
    <div className="relative">
      <div className="flex items-center gap-1.5">
        {/* Mobile: full-width input at 16px — anything smaller makes iOS Safari
            zoom the page on focus and stay zoomed after closing (owner report,
            2026-07-17). sm+ keeps the compact 208px/13px inline style. */}
        <div className="relative flex-1 sm:flex-none">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter' && results.length > 0) onSelect(results[0]);
            }}
            placeholder={placeholder}
            className="w-full sm:w-52 px-3 py-2 sm:py-1.5 pl-8 text-base sm:text-xs bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand/50"
          />
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 text-gray-500 hover:text-white"
          aria-label="Close search"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {query.length >= 2 && (
        <div className={`absolute top-full ${align === 'right' ? 'right-0' : 'left-0'} mt-1.5 w-full min-w-[calc(100vw-2rem)] sm:min-w-0 sm:w-80 bg-surface-raised border border-white/10 rounded-lg shadow-xl overflow-hidden z-[80] max-h-[min(18rem,60vh)] overflow-y-auto`}>
          {results.length > 0 ? results.map(show => {
            const disabled = isDisabled?.(show) ?? false;
            return (
              <button
                key={show.id}
                onClick={() => !disabled && onSelect(show)}
                disabled={disabled}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 transition-colors disabled:opacity-50"
              >
                {show.images?.thumbnail ? (
                  <img src={show.images.thumbnail} alt="" className="w-9 h-9 rounded object-cover flex-shrink-0" />
                ) : (
                  <div className="w-9 h-9 rounded bg-white/10 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white truncate">{show.title}</div>
                  <div className="text-[10px] text-gray-500 flex items-center gap-1.5">
                    <span className={`px-1 py-0.5 rounded font-medium ${
                      show.status === 'open' ? 'bg-green-500/20 text-green-400' :
                      show.status === 'previews' ? 'bg-yellow-500/20 text-yellow-400' :
                      'bg-gray-500/20 text-gray-400'
                    }`}>
                      {show.status === 'open' ? 'Now Playing' : show.status === 'previews' ? 'Previews' : show.status === 'upcoming' ? 'Upcoming' : show.status === 'announced' ? 'Announced' : 'Closed'}
                    </span>
                    <span className={`px-1 py-0.5 rounded font-medium ${
                      show.category === 'west-end' ? 'bg-purple-500/20 text-purple-400' :
                      show.category === 'off-west-end' ? 'bg-purple-500/20 text-purple-400' :
                      show.category === 'off-broadway' ? 'bg-indigo-500/20 text-indigo-400' :
                      show.category === 'regional' ? 'bg-emerald-500/20 text-emerald-400' :
                      'bg-blue-500/20 text-blue-400'
                    }`}>
                      {show.category === 'west-end' ? 'West End' :
                       show.category === 'off-west-end' ? 'Off-West End' :
                       show.category === 'off-broadway' ? 'Off-Bway' :
                       show.category === 'regional' ? 'Regional' : 'Broadway'}
                    </span>
                    {show.od && <span className="text-gray-500">{show.od.slice(0, 4)}</span>}
                    {show.dy && (
                      <span className="px-1 py-0.5 rounded font-medium bg-gray-500/20 text-gray-400">No critic score</span>
                    )}
                  </div>
                </div>
                <div className="flex-shrink-0 text-[10px] text-gray-500">
                  {renderAction(show)}
                </div>
              </button>
            );
          }) : (
            <div className="px-3 py-4 text-center text-xs text-gray-500">
              <p>No shows found for &ldquo;{query}&rdquo;</p>
              {enableLiveLookup && liveState === 'idle' && (
                <button
                  type="button"
                  onClick={runLiveSearch}
                  className="mt-2 text-brand hover:underline"
                >
                  Can&apos;t find it? Search the wider theater catalog
                </button>
              )}
              {enableLiveLookup && liveState === 'searching' && (
                <p className="mt-2 text-gray-400">Searching the wider catalog...</p>
              )}
              {enableLiveLookup && liveState === 'empty' && (
                <p className="mt-2 text-gray-500">Not found in the wider catalog either. Try a different spelling, or ask us to add it.</p>
              )}
              {enableLiveLookup && liveState === 'error' && (
                <div className="mt-2">
                  <p className="text-red-400">{liveError}</p>
                  <button type="button" onClick={runLiveSearch} className="mt-1 text-brand hover:underline">Try again</button>
                </div>
              )}
            </div>
          )}
          {enableLiveLookup && liveState === 'results' && liveCandidates.map(candidate => (
            <button
              key={candidate.id}
              onClick={() => { if (addingLiveId) return; setAddingLiveId(candidate.id); onLiveSelect?.(candidate); }}
              disabled={!!addingLiveId}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 transition-colors disabled:opacity-50"
            >
              {candidate.posterUrl ? (
                <img src={candidate.posterUrl} alt="" className="w-9 h-9 rounded object-cover flex-shrink-0" />
              ) : (
                <div className="w-9 h-9 rounded bg-white/10 flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-white truncate">{candidate.title}</div>
                <div className="text-[10px] text-gray-500 flex items-center gap-1.5 truncate">
                  {candidate.venue && <span className="truncate">{candidate.venue}</span>}
                  {candidate.city && <span>· {candidate.city}</span>}
                  {candidate.openingDate && <span>· {candidate.openingDate.slice(0, 4)}</span>}
                  <span className="px-1 py-0.5 rounded font-medium bg-gray-500/20 text-gray-400 flex-shrink-0">No critic score</span>
                </div>
              </div>
              <div className="flex-shrink-0 text-[10px] text-brand">{addingLiveId === candidate.id ? 'Adding...' : '+ Add'}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
