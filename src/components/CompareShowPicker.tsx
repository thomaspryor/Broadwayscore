'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type Fuse from 'fuse.js';

interface Show {
  title: string;
  slug: string;
  status: string;
  images?: { thumbnail?: string };
  category?: string;
}

function ShowInput({
  label,
  id,
  value,
  onChange,
  onSelect,
  results,
  showResults,
  onFocus,
}: {
  label: string;
  id: string;
  value: string;
  onChange: (q: string) => void;
  onSelect: (show: Show) => void;
  results: Show[];
  showResults: boolean;
  onFocus: () => void;
}) {
  return (
    <div className="relative flex-1">
      <label htmlFor={id} className="block text-xs text-gray-400 font-medium mb-1">{label}</label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={onFocus}
        placeholder="Type a show name..."
        className="w-full px-3 py-2.5 rounded-lg bg-surface-overlay border border-white/10 text-white text-sm placeholder:text-gray-500 focus:outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand/30"
        autoComplete="off"
      />
      {showResults && results.length > 0 && (
        <div className="absolute z-50 top-full mt-1 w-full bg-surface-raised border border-white/10 rounded-lg shadow-xl max-h-60 overflow-y-auto">
          {results.map(show => (
            <button
              key={show.slug}
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => onSelect(show)}
              className="w-full text-left px-3 py-2 hover:bg-white/5 transition-colors flex items-center gap-2"
            >
              {show.images?.thumbnail && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={show.images.thumbnail} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0" />
              )}
              <div className="min-w-0">
                <div className="text-sm text-white truncate">{show.title}</div>
                <div className="text-[11px] text-gray-500 capitalize">
                  {show.status}
                  {show.category && show.category !== 'broadway' && (
                    <span className="ml-1.5 text-gray-600">
                      · {show.category === 'west-end' ? 'West End' : show.category === 'off-broadway' ? 'Off-Broadway' : show.category === 'off-west-end' ? 'Off-West End' : show.category}
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CompareShowPicker() {
  const router = useRouter();
  const fuseRef = useRef<Fuse<Show> | null>(null);
  const fetchedRef = useRef(false);
  const [dataReady, setDataReady] = useState(false);

  const [queryA, setQueryA] = useState('');
  const [queryB, setQueryB] = useState('');
  const [selectedA, setSelectedA] = useState<Show | null>(null);
  const [selectedB, setSelectedB] = useState<Show | null>(null);
  const [focusedField, setFocusedField] = useState<'a' | 'b' | null>(null);

  const ensureData = useCallback(async () => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    try {
      const [res, { default: FuseClass }] = await Promise.all([
        fetch('/data/search-shows.json'),
        import('fuse.js/basic') as Promise<{ default: typeof Fuse }>,
      ]);
      if (!res.ok) return;
      const data: Show[] = await res.json();
      fuseRef.current = new FuseClass(data, {
        keys: [{ name: 'title', weight: 1.0 }],
        threshold: 0.35,
        ignoreLocation: true,
      });
      setDataReady(true);
    } catch { /* silent */ }
  }, []);

  // Close dropdown on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-compare-picker]')) {
        setFocusedField(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const search = (q: string, exclude?: string): Show[] => {
    if (!fuseRef.current || q.length < 2) return [];
    return fuseRef.current.search(q, { limit: 16 })
      .map(r => r.item)
      .filter(s => s.slug !== exclude)
      // Broadway first, then others — most users are comparing Broadway shows
      .sort((a, b) => {
        const aIsBway = !a.category || a.category === 'broadway' ? 0 : 1;
        const bIsBway = !b.category || b.category === 'broadway' ? 0 : 1;
        return aIsBway - bIsBway;
      })
      .slice(0, 8);
  };

  // Re-compute when dataReady changes (forces re-render after Fuse loads)
  const resultsA = dataReady ? search(queryA, selectedB?.slug) : [];
  const resultsB = dataReady ? search(queryB, selectedA?.slug) : [];

  const handleSelectA = (show: Show) => {
    setSelectedA(show);
    setQueryA(show.title);
    setFocusedField(null);
  };

  const handleSelectB = (show: Show) => {
    setSelectedB(show);
    setQueryB(show.title);
    setFocusedField(null);
  };

  const canCompare = selectedA && selectedB && selectedA.slug !== selectedB.slug;

  const handleCompare = () => {
    if (!canCompare) return;
    router.push(`/compare/${selectedA!.slug}-vs-${selectedB!.slug}`);
  };

  return (
    <div className="card p-4 sm:p-6 mb-8" data-compare-picker>
      <h2 className="font-bold text-white text-lg mb-1">Compare Any Two Shows</h2>
      <p className="text-gray-400 text-sm mb-4">Pick two shows to see a detailed side-by-side comparison.</p>

      <div className="flex flex-col sm:flex-row gap-3 items-end" onFocus={ensureData}>
        <ShowInput
          label="Show 1"
          id="compare-show-a"
          value={queryA}
          onChange={q => { setQueryA(q); setSelectedA(null); }}
          onSelect={handleSelectA}
          results={resultsA}
          showResults={focusedField === 'a' && !selectedA && queryA.length >= 2}
          onFocus={() => setFocusedField('a')}
        />

        <div className="hidden sm:flex items-center pb-2">
          <span className="px-2 py-1 rounded-full bg-brand/20 text-brand text-xs font-bold">VS</span>
        </div>

        <ShowInput
          label="Show 2"
          id="compare-show-b"
          value={queryB}
          onChange={q => { setQueryB(q); setSelectedB(null); }}
          onSelect={handleSelectB}
          results={resultsB}
          showResults={focusedField === 'b' && !selectedB && queryB.length >= 2}
          onFocus={() => setFocusedField('b')}
        />

        <button
          onClick={handleCompare}
          disabled={!canCompare}
          className="px-5 py-2.5 rounded-lg bg-brand text-black font-semibold text-sm transition-colors hover:bg-brand-hover disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap"
        >
          Compare
        </button>
      </div>
    </div>
  );
}
