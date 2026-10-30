'use client';

import { useState, useRef, useEffect } from 'react';
import type { FantasyShow } from '@/config/fantasy';
import { ELIGIBILITY_MARKERS, isShowOpenForDrafter, isAudienceLockedForEntry, earnsBoxOffice, scoringFromDate } from '@/config/fantasy';
import { getOptimizedImageUrl } from '@/lib/images';
import { showFormatTitle } from '@/lib/show-format';
import { getScoreColor } from '@/config/score-buckets';
import FantasyOwnershipTag from './FantasyOwnershipTag';

interface FantasyShowPickerProps {
  shows: Array<{ id: string } & FantasyShow>;
  selectedIds: string[];
  onSelect: (showId: string) => void;
  onRemove: (showId: string) => void;
  remainingBudget: number;
  slotIndex: number;
  /** The drafter's clock: a show that has opened by now earns them no critic/audience points. */
  now: Date;
}

export default function FantasyShowPicker({
  shows,
  selectedIds,
  onSelect,
  onRemove,
  remainingBudget,
  slotIndex,
  now,
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
  // Box office for this drafter starts the week they draft (rolling scoring).
  const boxOfficeFrom = scoringFromDate(now.toISOString());

  // Filter available shows
  const available = shows.filter(s => {
    if (selectedIds.includes(s.id) && s.id !== selectedIds[slotIndex]) return false;
    if (search && !s.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // Sort: affordable first, closed shows last, then by price desc
  const sorted = [...available].sort((a, b) => {
    const aAffordable = a.price <= remainingBudget + (selectedShow?.price ?? 0);
    const bAffordable = b.price <= remainingBudget + (selectedShow?.price ?? 0);
    if (aAffordable && !bAffordable) return -1;
    if (!aAffordable && bAffordable) return 1;
    const aClosed = a.status === 'closed';
    const bClosed = b.status === 'closed';
    if (aClosed !== bClosed) return aClosed ? 1 : -1;
    return b.price - a.price;
  });

  if (selectedShow && !isOpen) {
    return (
      <div className="flex items-center gap-3 rounded-lg bg-surface-raised border border-white/10 p-3">
        <span className="text-xs text-fg-muted font-mono w-5">{slotIndex + 1}</span>
        {selectedShow.image && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={getOptimizedImageUrl(selectedShow.image, 'thumbnail')} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-white truncate">{selectedShow.title}</span>
            {selectedShow.category === 'off-broadway' && (
              <span className="text-xs bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded">OB</span>
            )}
            {selectedShow.status === 'closed' && (
              <span className="text-xs bg-gray-500/20 text-fg-muted px-1.5 py-0.5 rounded">Closed</span>
            )}
          </div>
          <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap text-xs text-gray-400 mt-0.5">
            <span className="whitespace-nowrap">{showFormatTitle(selectedShow.type)}</span>
            {isShowOpenForDrafter(selectedShow, now) ? (
              <span className="text-score-tepid whitespace-nowrap">
                {ELIGIBILITY_MARKERS.criticScoreLocked} Already open{earnsBoxOffice(selectedShow, boxOfficeFrom) ? '' : ': awards only'}
              </span>
            ) : (
              <>
                {selectedShow.criticScore != null && (
                  <span className={`${getScoreColor(Math.round(selectedShow.criticScore))} whitespace-nowrap`}>Score: {Math.round(selectedShow.criticScore)}</span>
                )}
                {selectedShow.audienceGrade != null && (
                  <span className="text-gray-300 whitespace-nowrap">
                    Grade: {selectedShow.audienceGrade}
                    {isAudienceLockedForEntry(selectedShow.audienceGradeSince, now.toISOString()) && <span className="text-fg-muted"> (public: no audience pts)</span>}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        <span className="font-bold text-emerald-400">${selectedShow.price}</span>
        <button
          onClick={() => onRemove(selectedShow.id)}
          className="text-fg-muted hover:text-red-400 transition-colors p-2 -m-1"
          aria-label={`Remove ${selectedShow.title}`}
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
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        aria-label={`Pick a show for slot ${slotIndex + 1}`}
        className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
          isOpen ? 'bg-surface-overlay border-brand/50' : 'bg-surface-raised/50 border-white/10 border-dashed hover:border-white/20'
        }`}
        onClick={() => setIsOpen(true)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsOpen(true); } }}
      >
        <span className="text-xs text-fg-muted font-mono w-5">{slotIndex + 1}</span>
        {isOpen ? (
          <input
            type="text"
            className="flex-1 bg-transparent text-white placeholder-gray-500 outline-none text-base sm:text-sm"
            placeholder="Search shows..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
        ) : (
          <span className="flex-1 text-sm text-fg-muted">Pick a show...</span>
        )}
      </div>

      {isOpen && (
        <>
          {/* Mobile backdrop */}
          <div
            className="fixed inset-0 bg-black/60 z-40 sm:hidden"
            onClick={() => { setIsOpen(false); setSearch(''); }}
          />
          <div className="fixed sm:absolute inset-x-0 bottom-0 sm:bottom-auto sm:inset-x-auto sm:left-0 sm:right-0 sm:mt-1 z-50 max-h-[70vh] sm:max-h-80 overflow-y-auto rounded-t-xl sm:rounded-lg bg-surface-raised border border-white/10 shadow-xl">
            {/* Mobile search header (sticky) */}
            <div className="sticky top-0 bg-surface-raised border-b border-white/10 p-3 sm:hidden">
              <input
                type="text"
                className="w-full bg-surface-overlay text-white placeholder-fg-placeholder rounded-lg px-3 py-2 text-base outline-none focus:ring-1 focus:ring-brand/50"
                placeholder="Search shows..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                autoFocus
              />
            </div>
            {sorted.length === 0 ? (
              <div className="p-3 text-sm text-fg-muted text-center">No matching shows</div>
            ) : (
            sorted.map(show => {
              const affordable = show.price <= remainingBudget + (selectedShow?.price ?? 0);
              return (
                <button
                  key={show.id}
                  className={`w-full flex items-center gap-3 p-3 text-left transition-colors border-b border-white/5 last:border-0 ${
                    affordable
                      ? 'hover:bg-surface-overlay text-white'
                      : 'opacity-40 cursor-not-allowed text-fg-muted'
                  }`}
                  onClick={() => {
                    if (!affordable) return;
                    onSelect(show.id);
                    setSearch('');
                    setIsOpen(false);
                  }}
                  disabled={!affordable}
                >
                  {show.image && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={getOptimizedImageUrl(show.image, 'thumbnail')} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{show.title}</span>
                      {show.category === 'off-broadway' && (
                        <span className="text-xs bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded shrink-0">OB</span>
                      )}
                      {show.status === 'closed' && (
                        <span className="text-xs bg-gray-500/20 text-fg-muted px-1.5 py-0.5 rounded shrink-0">Closed</span>
                      )}
                    </div>
                    <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap text-xs text-gray-400 mt-0.5">
                      <span className="whitespace-nowrap">{showFormatTitle(show.type)}</span>
                      {isShowOpenForDrafter(show, now) ? (
                        <span className="text-score-tepid whitespace-nowrap">
                          {ELIGIBILITY_MARKERS.criticScoreLocked} Already open{earnsBoxOffice(show, boxOfficeFrom) ? '' : ': awards only'}{show.criticScore != null ? ` · Score ${Math.round(show.criticScore)}` : ''}
                        </span>
                      ) : (
                        <>
                          {show.criticScore != null && (
                            <span className={`${getScoreColor(Math.round(show.criticScore))} whitespace-nowrap`}>Score: {Math.round(show.criticScore)}</span>
                          )}
                          {show.audienceGrade != null && (
                            <span className="text-gray-300 whitespace-nowrap">
                              Grade: {show.audienceGrade}
                              {isAudienceLockedForEntry(show.audienceGradeSince, now.toISOString()) && <span className="text-fg-muted"> (public: no audience pts)</span>}
                            </span>
                          )}
                          {show.openingDate && (
                            <span className="text-fg-muted whitespace-nowrap">opens {new Date(`${show.openingDate}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</span>
                          )}
                        </>
                      )}
                      {!earnsBoxOffice(show, boxOfficeFrom) && show.eligible.boxOffice && (
                        <span className="text-gray-400 whitespace-nowrap">† closes before your box office starts</span>
                      )}
                      {!show.eligible.boxOffice && (
                        <span className="text-gray-400 whitespace-nowrap">† no box office</span>
                      )}
                      <FantasyOwnershipTag showId={show.id} />
                    </div>
                  </div>
                  <span className={`font-bold shrink-0 ${affordable ? 'text-emerald-400' : 'text-fg-muted'}`}>
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
