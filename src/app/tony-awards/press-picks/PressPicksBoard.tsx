'use client';

import { useState, useEffect } from 'react';
import { OutletPickLogo } from '@/components/tony/OutletPickLogo';

export interface BoardNominee {
  key: string;
  name: string;
  sub: string | null;
  will: string[];   // outlet IDs that predicted this to WIN
  should: string[]; // outlet IDs that said this SHOULD win
}
export interface BoardCategory {
  key: string;
  title: string;
  nominees: BoardNominee[];
}
export interface BoardSource {
  id: string;
  outlet: string;
  critic: string;
}

// Display order only — NOT a credibility ranking. Every outlet is one equal vote.
const OUTLET_ORDER = ['nyt', 'nytpaulson', 'variety', 'thr', 'thewrap', 'timeout', 'slant', 'bg', 'chitrib', 'timesuk', 'nytg', 'theatermania', 'nysun', 'ew', 'deadline', 'culturesauce', 'cityguide', 'parade', 'vf', 'elle', '1minutecritic', 'rbroadway'];
const orderIdx = (id: string) => {
  const i = OUTLET_ORDER.indexOf(id);
  return i === -1 ? 999 : i;
};

type Mode = 'will' | 'should';

export function PressPicksBoard({ categories, sources }: { categories: BoardCategory[]; sources: BoardSource[] }) {
  const [mode, setMode] = useState<Mode>('will');

  // Deep-link support: ?view=should opens directly in Should Win mode.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('view') === 'should') setMode('should');
  }, []);

  // Keep the URL in sync so the current view is shareable (no full navigation).
  const selectMode = (m: Mode) => {
    setMode(m);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (m === 'should') url.searchParams.set('view', 'should');
      else url.searchParams.delete('view');
      window.history.replaceState(null, '', url);
    }
  };

  // Outlets participating in the active mode (have at least one pick somewhere).
  const activeOutletIds = new Set<string>();
  for (const cat of categories) {
    for (const nom of cat.nominees) {
      for (const id of nom[mode]) activeOutletIds.add(id);
    }
  }
  const legend = sources
    .filter(s => activeOutletIds.has(s.id))
    .sort((a, b) => orderIdx(a.id) - orderIdx(b.id));

  const tabBase = 'px-3 py-1.5 text-sm font-semibold rounded-full transition-colors';
  return (
    <>
      {/* Toggle */}
      <div className="mt-4 inline-flex items-center gap-1 p-1 rounded-full bg-surface-overlay">
        <button
          type="button"
          onClick={() => selectMode('will')}
          className={`${tabBase} ${mode === 'will' ? 'bg-amber-400 text-black' : 'text-gray-300 hover:text-white'}`}
          aria-pressed={mode === 'will'}
        >
          Will Win
        </button>
        <button
          type="button"
          onClick={() => selectMode('should')}
          className={`${tabBase} ${mode === 'should' ? 'bg-amber-400 text-black' : 'text-gray-300 hover:text-white'}`}
          aria-pressed={mode === 'should'}
        >
          Should Win
        </button>
      </div>

      <p className="mt-2.5 text-sm text-gray-400">
        {mode === 'will' ? (
          <>Who <span className="text-gray-200 font-semibold">{legend.length} outlets</span> predict <span className="text-gray-200 font-semibold">will win</span>. Bars show how many agree on each nominee.</>
        ) : (
          <>Who <span className="text-gray-200 font-semibold">{legend.length} critics</span> say <span className="text-gray-200 font-semibold">should win</span> — their personal favorite, separate from the prediction. A thinner field; not every outlet offers a &quot;should win.&quot;</>
        )}
      </p>

      {/* Legend */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
        {legend.map(s => (
          <div key={s.id} className="flex items-center gap-1.5">
            <OutletPickLogo outletId={s.id} />
            <span className="text-[11px] text-gray-400 leading-none">
              <span className="text-gray-200 font-medium">{s.outlet}</span>
              <span className="text-gray-500"> · {s.critic}</span>
            </span>
          </div>
        ))}
      </div>

      {/* Category blocks */}
      <div className="mt-6 space-y-5">
        {categories.map(cat => {
          const nominees = [...cat.nominees].sort(
            (a, b) => b[mode].length - a[mode].length || a.name.localeCompare(b.name),
          );
          const coveringOutlets = new Set(cat.nominees.flatMap(n => n[mode])).size;
          if (coveringOutlets === 0) return null; // no data for this category in this mode

          return (
            <section key={cat.key} className="bg-surface-raised rounded-xl p-4 sm:p-5">
              <div className="flex items-baseline justify-between gap-2 mb-3">
                <h2 className="text-sm font-bold uppercase tracking-wide text-gray-300">{cat.title}</h2>
                <span className="text-[11px] text-gray-500 flex-shrink-0">
                  {coveringOutlets} weighed in
                </span>
              </div>

              <div className="space-y-2">
                {nominees.map(nom => {
                  const count = nom[mode].length;
                  return (
                    <div key={nom.key} className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3">
                      <div className="sm:w-44 sm:flex-shrink-0 min-w-0">
                        <div className="text-sm truncate text-gray-200">{nom.name}</div>
                        {nom.sub && <div className="text-[10px] text-gray-500 truncate">{nom.sub}</div>}
                      </div>
                      <div className="flex items-center gap-2 sm:flex-1 min-w-0">
                        <div className="flex-1 min-w-0 h-2.5 rounded-full bg-surface-overlay overflow-hidden">
                          <div
                            className="h-full rounded-full bg-amber-400"
                            style={{ width: `${(count / Math.max(1, coveringOutlets)) * 100}%` }}
                          />
                        </div>
                        <div className="w-5 flex-shrink-0 text-right text-sm tabular-nums text-gray-300">{count}</div>
                      </div>
                      <div className="flex flex-wrap items-center gap-0.5 sm:w-[112px] sm:flex-shrink-0">
                        {[...nom[mode]].sort((a, b) => orderIdx(a) - orderIdx(b)).map(id => (
                          <OutletPickLogo key={id} outletId={id} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
