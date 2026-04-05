'use client';

import { useState, useRef, useCallback, useDeferredValue } from 'react';
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
  value,
  onChange,
  onSelect,
  results,
  showResults,
  onFocus,
}: {
  label: string;
  value: string;
  onChange: (q: string) => void;
  onSelect: (show: Show) => void;
  results: Show[];
  showResults: boolean;
  onFocus: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div ref={ref} className="relative flex-1">
      <label className="block text-xs text-gray-400 font-medium mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={onFocus}
        placeholder="Type a show name..."
        className="w-full px-3 py-2.5 rounded-lg bg-surface-overlay border border-white/10 text-white text-sm placeholder:text-gray-500 focus:outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand/30"
      />
      {showResults && results.length > 0 && (
        <div className="absolute z-50 top-full mt-1 w-full bg-surface-raised border border-white/10 rounded-lg shadow-xl max-h-60 overflow-y-auto">
          {results.map(show => (
            <button
              key={show.slug}
              type="button"
              onClick={() => onSelect(show)}
              className="w-full text-left px-3 py-2 hover:bg-white/5 transition-colors flex items-center gap-2"
            >
              {show.images?.thumbnail && (
                <img src={show.images.thumbnail} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0" />
              )}
              <div className="min-w-0">
                <div className="text-sm text-white truncate">{show.title}</div>
                <div className="text-[11px] text-gray-500 capitalize">{show.status}</div>
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

  const [queryA, setQueryA] = useState('');
  const [queryB, setQueryB] = useState('');
  const deferredA = useDeferredValue(queryA);
  const deferredB = useDeferredValue(queryB);
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
    } catch { /* silent */ }
  }, []);

  const search = (q: string, exclude?: string): Show[] => {
    if (!fuseRef.current || q.length < 2) return [];
    return fuseRef.current.search(q, { limit: 8 })
      .map(r => r.item)
      .filter(s => s.slug !== exclude);
  };

  const resultsA = search(deferredA, selectedB?.slug);
  const resultsB = search(deferredB, selectedA?.slug);

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
    <div className="card p-4 sm:p-6 mb-8">
      <h2 className="font-bold text-white text-lg mb-1">Compare Any Two Shows</h2>
      <p className="text-gray-400 text-sm mb-4">Pick two shows to see a detailed side-by-side comparison.</p>

      <div className="flex flex-col sm:flex-row gap-3 items-end" onFocus={ensureData}>
        <ShowInput
          label="Show 1"
          value={queryA}
          onChange={q => { setQueryA(q); setSelectedA(null); }}
          onSelect={handleSelectA}
          results={resultsA}
          showResults={focusedField === 'a' && !selectedA && deferredA.length >= 2}
          onFocus={() => setFocusedField('a')}
        />

        <div className="hidden sm:flex items-center pb-2">
          <span className="px-2 py-1 rounded-full bg-brand/20 text-brand text-xs font-bold">VS</span>
        </div>

        <ShowInput
          label="Show 2"
          value={queryB}
          onChange={q => { setQueryB(q); setSelectedB(null); }}
          onSelect={handleSelectB}
          results={resultsB}
          showResults={focusedField === 'b' && !selectedB && deferredB.length >= 2}
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
