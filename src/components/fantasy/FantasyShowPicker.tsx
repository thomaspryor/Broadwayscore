'use client';

import { useState, useRef, useEffect } from 'react';
import type { FantasyShow } from '@/config/fantasy';

interface FantasyShowPickerProps {
  shows: Array<{ id: string } & FantasyShow>;
  selectedIds: string[];
  onSelect: (showId: string) => void;
  onRemove: (showId: string) => void;
  remainingBudget: number;
  slotIndex: number;
}

export default function FantasyShowPicker({
  shows,
  selectedIds,
  onSelect,
  onRemove,
  remainingBudget,
  slotIndex,
}: FantasyShowPickerProps) {
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const selectedShow = shows.find(s => s.id === selectedIds[slotIndex]);

  // Filter available shows
  const available = shows.filter(s => {
    if (selectedIds.includes(s.id) && s.id !== selectedIds[slotIndex]) return false;
    if (search && !s.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // Sort: affordable first, then by price desc
  const sorted = [...available].sort((a, b) => {
    const aAffordable = a.price <= remainingBudget + (selectedShow?.price ?? 0);
    const bAffordable = b.price <= remainingBudget + (selectedShow?.price ?? 0);
    if (aAffordable && !bAffordable) return -1;
    if (!aAffordable && bAffordable) return 1;
    return b.price - a.price;
  });

  if (selectedShow && !isOpen) {
    return (
      <div className="flex items-center gap-3 rounded-lg bg-zinc-800 border border-zinc-600 p-3">
        <span className="text-xs text-zinc-500 font-mono w-5">{slotIndex + 1}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-white truncate">{selectedShow.title}</span>
            {selectedShow.category === 'off-broadway' && (
              <span className="text-[10px] bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded">OB</span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-400 mt-0.5">
            <span>{selectedShow.type === 'musical' ? 'Musical' : 'Play'}</span>
            {selectedShow.criticScore && (
              <span className="text-yellow-400">Score: {Math.round(selectedShow.criticScore)}</span>
            )}
          </div>
        </div>
        <span className="font-bold text-emerald-400">${selectedShow.price}</span>
        <button
          onClick={() => onRemove(selectedShow.id)}
          className="text-zinc-500 hover:text-red-400 transition-colors p-1"
          aria-label="Remove pick"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <div
        className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
          isOpen ? 'bg-zinc-700 border-brand/50' : 'bg-zinc-800/50 border-zinc-700 border-dashed hover:border-zinc-500'
        }`}
        onClick={() => setIsOpen(true)}
      >
        <span className="text-xs text-zinc-500 font-mono w-5">{slotIndex + 1}</span>
        {isOpen ? (
          <input
            type="text"
            className="flex-1 bg-transparent text-white placeholder-zinc-500 outline-none text-sm"
            placeholder="Search shows..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
        ) : (
          <span className="flex-1 text-sm text-zinc-500">Pick a show...</span>
        )}
      </div>

      {isOpen && (
        <>
          {/* Mobile backdrop */}
          <div
            className="fixed inset-0 bg-black/60 z-40 sm:hidden"
            onClick={() => { setIsOpen(false); setSearch(''); }}
          />
          <div className="fixed sm:absolute inset-x-0 bottom-0 sm:bottom-auto sm:inset-x-auto sm:left-0 sm:right-0 sm:mt-1 z-50 max-h-[70vh] sm:max-h-80 overflow-y-auto rounded-t-xl sm:rounded-lg bg-zinc-800 border border-zinc-600 shadow-xl">
            {/* Mobile search header (sticky) */}
            <div className="sticky top-0 bg-zinc-800 border-b border-zinc-700 p-3 sm:hidden">
              <input
                type="text"
                className="w-full bg-zinc-700 text-white placeholder-zinc-400 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-brand/50"
                placeholder="Search shows..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                autoFocus
              />
            </div>
            {sorted.length === 0 ? (
              <div className="p-3 text-sm text-zinc-500 text-center">No matching shows</div>
            ) : (
            sorted.map(show => {
              const affordable = show.price <= remainingBudget + (selectedShow?.price ?? 0);
              return (
                <button
                  key={show.id}
                  className={`w-full flex items-center gap-3 p-3 text-left transition-colors border-b border-zinc-700/50 last:border-0 ${
                    affordable
                      ? 'hover:bg-zinc-700 text-white'
                      : 'opacity-40 cursor-not-allowed text-zinc-500'
                  }`}
                  onClick={() => {
                    if (!affordable) return;
                    onSelect(show.id);
                    setSearch('');
                    setIsOpen(false);
                  }}
                  disabled={!affordable}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{show.title}</span>
                      {show.category === 'off-broadway' && (
                        <span className="text-[10px] bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded shrink-0">OB</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-zinc-400 mt-0.5">
                      <span>{show.type === 'musical' ? 'Musical' : 'Play'}</span>
                      {show.criticScore && (
                        <span className="text-yellow-400">Score: {Math.round(show.criticScore)}</span>
                      )}
                      {!show.eligible.boxOffice && (
                        <span className="text-zinc-500">† no box office</span>
                      )}
                    </div>
                  </div>
                  <span className={`font-bold shrink-0 ${affordable ? 'text-emerald-400' : 'text-zinc-600'}`}>
                    ${show.price}
                  </span>
                </button>
              );
            })
          )}
        </div>
        </>
      )}
    </div>
  );
}
