'use client';
// DO NOT add PostHog instrumentation here — this component is used exclusively
// for /my-shows list management (adding shows to lists), not public browse search.
// Search analytics belong in HeaderSearch.tsx.

import { useEffect, useRef, type ReactNode } from 'react';
import { useShowSearch } from '@/hooks/useShowSearch';

interface SearchShow {
  id: string;
  title: string;
  slug: string;
  status: string;
  venue?: string;
  od?: string;
  images?: { thumbnail?: string };
  category?: string;
}

interface ShowSearchDropdownProps {
  placeholder?: string;
  onSelect: (show: SearchShow) => void;
  onClose: () => void;
  renderAction: (show: SearchShow) => ReactNode;
  isDisabled?: (show: SearchShow) => boolean;
  align?: 'left' | 'right';
  autoFocus?: boolean;
}

export default function ShowSearchDropdown({
  placeholder = 'Search to add...',
  onSelect,
  onClose,
  renderAction,
  isDisabled,
  align = 'left',
  autoFocus = true,
}: ShowSearchDropdownProps) {
  const { query, setQuery, results, ensureData } = useShowSearch<SearchShow>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) {
      ensureData();
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [autoFocus, ensureData]);

  return (
    <div className="relative">
      <div className="flex items-center gap-1.5">
        <div className="relative">
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
            className="w-40 sm:w-52 px-3 py-1.5 pl-8 text-xs bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand/50"
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
        <div className={`absolute top-full ${align === 'right' ? 'right-0' : 'left-0'} mt-1.5 w-[calc(100vw-2rem)] sm:w-80 bg-surface-raised border border-white/10 rounded-lg shadow-xl overflow-hidden z-[80] max-h-72 overflow-y-auto`}>
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
                      {show.status === 'open' ? 'Now Playing' : show.status === 'previews' ? 'Previews' : 'Closed'}
                    </span>
                    <span className={`px-1 py-0.5 rounded font-medium ${
                      show.category === 'west-end' ? 'bg-purple-500/20 text-purple-400' :
                      show.category === 'off-west-end' ? 'bg-purple-500/20 text-purple-400' :
                      show.category === 'off-broadway' ? 'bg-indigo-500/20 text-indigo-400' :
                      'bg-blue-500/20 text-blue-400'
                    }`}>
                      {show.category === 'west-end' ? 'West End' :
                       show.category === 'off-west-end' ? 'Off-West End' :
                       show.category === 'off-broadway' ? 'Off-Bway' : 'Broadway'}
                    </span>
                    {show.od && <span className="text-gray-500">{show.od.slice(0, 4)}</span>}
                  </div>
                </div>
                <div className="flex-shrink-0 text-[10px] text-gray-500">
                  {renderAction(show)}
                </div>
              </button>
            );
          }) : (
            <div className="px-3 py-4 text-center text-xs text-gray-500">
              No shows found for &ldquo;{query}&rdquo;
            </div>
          )}
        </div>
      )}
    </div>
  );
}
