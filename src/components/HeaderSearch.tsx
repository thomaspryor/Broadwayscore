'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface Show {
  id: string;
  title: string;
  slug: string;
  status: string;
  venue?: string;
  images?: {
    thumbnail?: string;
  };
}

interface HeaderSearchProps {
  shows: Show[];
}

export default function HeaderSearch({ shows }: HeaderSearchProps) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Filter shows based on query
  const filteredShows = useMemo(() => {
    if (query.length < 1) return [];
    return shows
      .filter(show =>
        show.title.toLowerCase().includes(query.toLowerCase())
      )
      .slice(0, 8); // Limit to 8 results
  }, [query, shows]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setIsMobileOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isOpen || filteredShows.length === 0) {
      if (e.key === 'Enter' && query.length > 0) {
        // Navigate to first result on Enter
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
  }, [isOpen, filteredShows, selectedIndex, router, query]);

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(-1);
  }, [query]);

  const handleResultClick = (slug: string) => {
    router.push(`/show/${slug}`);
    setIsOpen(false);
    setIsMobileOpen(false);
    setQuery('');
    setSelectedIndex(-1);
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Desktop search input */}
      <div className="hidden sm:block relative">
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIsOpen(e.target.value.length >= 1);
            }}
            onFocus={() => query.length >= 1 && setIsOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder="Search shows..."
            className="w-48 lg:w-56 px-3 py-1.5 pl-9 text-sm bg-white/5 border border-white/10 rounded-lg
                       text-white placeholder-gray-400
                       focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand/50
                       transition-all duration-200"
            aria-label="Search Broadway shows"
            role="combobox"
            aria-expanded={isOpen}
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
            className="absolute top-full right-0 mt-2 w-80 bg-surface-raised border border-white/10 rounded-lg shadow-xl overflow-hidden z-50"
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
                    alt=""
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
                                      'bg-gray-500/20 text-gray-400'}`}>
                      {show.status === 'open' ? 'Now Playing' :
                       show.status === 'previews' ? 'In Previews' : 'Closed'}
                    </span>
                    {show.venue && <span className="truncate">{show.venue}</span>}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* No results message */}
        {isOpen && query.length >= 1 && filteredShows.length === 0 && (
          <div className="absolute top-full right-0 mt-2 w-80 bg-surface-raised border border-white/10 rounded-lg shadow-xl p-4 z-50">
            <p className="text-sm text-gray-400 text-center">No shows found for &ldquo;{query}&rdquo;</p>
          </div>
        )}
      </div>

      {/* Mobile search button */}
      <button
        onClick={() => setIsMobileOpen(true)}
        className="sm:hidden p-2 text-gray-400 hover:text-white transition-colors"
        aria-label="Search shows"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </button>

      {/* Mobile search overlay */}
      {isMobileOpen && (
        <div className="fixed inset-0 z-[100] bg-surface sm:hidden">
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
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Search Broadway shows..."
                  className="w-full px-4 py-2 pl-10 text-base bg-white/5 border border-white/10 rounded-lg
                             text-white placeholder-gray-400
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
                          alt=""
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
                                            'bg-gray-500/20 text-gray-400'}`}>
                            {show.status === 'open' ? 'Now Playing' :
                             show.status === 'previews' ? 'In Previews' : 'Closed'}
                          </span>
                          {show.venue && <span className="truncate">{show.venue}</span>}
                        </div>
                      </div>
                      <svg className="w-5 h-5 text-gray-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  ))}
                </div>
              ) : query.length >= 1 ? (
                <div className="p-8 text-center">
                  <p className="text-gray-400">No shows found for &ldquo;{query}&rdquo;</p>
                </div>
              ) : (
                <div className="p-8 text-center">
                  <p className="text-gray-400">Type to search for Broadway shows</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
