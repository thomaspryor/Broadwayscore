'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
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
  year?: string;
}

const SEARCH_KEYS = [
  { name: 'title', weight: 0.8 },
  { name: 'venue', weight: 0.2 },
];

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
  onSelect: (show: SearchShow) => void;
  results: SearchShow[];
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
        <div className="absolute z-[80] top-full mt-1 w-full sm:w-80 bg-surface-raised border border-white/10 rounded-lg shadow-xl max-h-72 overflow-y-auto">
          {results.map(show => {
            const year = show.year || show.od?.slice(0, 4);
            return (
              <button
                key={show.id}
                type="button"
                onMouseDown={e => e.preventDefault()}
                onClick={() => onSelect(show)}
                className="w-full text-left px-3 py-2 hover:bg-white/5 transition-colors flex items-center gap-2.5"
              >
                {show.images?.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
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
                    {show.category === 'west-end' && (
                      <span className="px-1 py-0.5 rounded font-medium bg-purple-500/20 text-purple-400">West End</span>
                    )}
                    {show.category === 'off-west-end' && (
                      <span className="px-1 py-0.5 rounded font-medium bg-purple-500/20 text-purple-400">Off-West End</span>
                    )}
                    {show.category === 'off-broadway' && (
                      <span className="px-1 py-0.5 rounded font-medium bg-indigo-500/20 text-indigo-400">Off-Bway</span>
                    )}
                    <span className="truncate text-gray-500">
                      {[show.venue, year].filter(Boolean).join(' \u00b7 ')}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function CompareShowPicker() {
  const router = useRouter();
  const searchA = useShowSearch<SearchShow>({ keys: SEARCH_KEYS, limit: 12 });
  const searchB = useShowSearch<SearchShow>({ keys: SEARCH_KEYS, limit: 12 });

  const [queryA, setQueryA] = useState('');
  const [queryB, setQueryB] = useState('');
  const [selectedA, setSelectedA] = useState<SearchShow | null>(null);
  const [selectedB, setSelectedB] = useState<SearchShow | null>(null);
  const [focusedField, setFocusedField] = useState<'a' | 'b' | null>(null);

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

  // Broadway-first sorting + exclude other selection
  const sortAndFilter = (results: SearchShow[], exclude?: string): SearchShow[] => {
    return results
      .filter(s => s.slug !== exclude)
      .sort((a, b) => {
        const aIsBway = !a.category || a.category === 'broadway' ? 0 : 1;
        const bIsBway = !b.category || b.category === 'broadway' ? 0 : 1;
        return aIsBway - bIsBway;
      })
      .slice(0, 8);
  };

  // Sync queries into the shared hooks
  useEffect(() => { searchA.setQuery(queryA); }, [queryA]);
  useEffect(() => { searchB.setQuery(queryB); }, [queryB]);

  const resultsA = sortAndFilter(searchA.results, selectedB?.slug);
  const resultsB = sortAndFilter(searchB.results, selectedA?.slug);

  const handleSelectA = (show: SearchShow) => {
    setSelectedA(show);
    setQueryA(show.title);
    setFocusedField(null);
  };

  const handleSelectB = (show: SearchShow) => {
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

      <div className="flex flex-col sm:flex-row gap-3 items-end" onFocus={() => { searchA.ensureData(); searchB.ensureData(); }}>
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
