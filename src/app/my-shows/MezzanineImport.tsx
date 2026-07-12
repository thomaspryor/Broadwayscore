'use client';

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type Fuse from 'fuse.js';
import { supabaseRestInsert } from '@/lib/supabase-rest';
import { Modal, ModalCloseButton } from '@/components/show-cards';

// Mezzanine JSON shape
interface MezzEntry {
  show: { name: string; id: string };
  rating: number | null;
  date: string | null;
  review: string | null;
  seat: string | null;
  production?: {
    theater?: { name: string; location?: string };
  };
}

interface MezzList {
  name: string;
  shows: { name: string; id: string }[];
}

interface MezzExport {
  appVersion?: string;
  data: {
    diaryEntries: MezzEntry[];
    lists: MezzList[];
  };
}

// Our search-shows.json shape (also covers diary-search.json grouped entries)
interface SearchShow {
  id: string;
  title: string;
  slug: string;
  status: string;
  venue?: string;
  category?: string;
  images?: { thumbnail?: string };
  prods?: { id: string; v?: string; ci?: string; co?: string; cat?: string }[];
  gid?: string;
}

interface MatchedEntry {
  mezzName: string;
  mezzRating: number | null;
  mezzDate: string | null;
  mezzReview: string | null;
  match: SearchShow | null;
  matchScore: number;
  selected: boolean;
  type: 'diary' | 'watchlist';
  listName?: string;
}

type ImportStep = 'closed' | 'upload' | 'matching' | 'preview' | 'importing' | 'done';

interface MezzanineImportProps {
  userId: string;
  existingReviewShowIds: Set<string>;
  existingWatchlistShowIds: Set<string>;
  onImportComplete: () => void;
}

export default function MezzanineImport({
  userId,
  existingReviewShowIds,
  existingWatchlistShowIds,
  onImportComplete,
}: MezzanineImportProps) {
  const [step, setStep] = useState<ImportStep>('closed');
  const [entries, setEntries] = useState<MatchedEntry[]>([]);
  const [importStats, setImportStats] = useState({ imported: 0, skipped: 0, errors: 0 });
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fuseRef = useRef<Fuse<SearchShow> | null>(null);
  const showsRef = useRef<SearchShow[]>([]);

  // Load search data + Fuse.js (scored shows + diary shows)
  const ensureSearchData = useCallback(async () => {
    if (fuseRef.current) return;
    const [res, diaryRes, { default: FuseClass }] = await Promise.all([
      fetch('/data/search-shows.json'),
      fetch('/data/diary-search.json').catch(() => null),
      import('fuse.js/basic') as Promise<{ default: typeof Fuse }>,
    ]);
    const data: SearchShow[] = await res.json();
    // Merge diary shows — expand multi-prod groups into individual entries and add
    // diary entries with distinct venues for venue-aware import matching.
    if (diaryRes?.ok) {
      try {
        const diaryData: SearchShow[] = await diaryRes.json();
        const existingVenues = new Map<string, Set<string>>();
        for (const s of data) {
          const key = s.title.toLowerCase();
          if (!existingVenues.has(key)) existingVenues.set(key, new Set());
          if (s.venue) existingVenues.get(key)!.add(s.venue.toLowerCase());
        }
        for (const s of diaryData) {
          const titleLower = s.title.toLowerCase();
          // Expand multi-prod groups into individual entries with venues
          if (s.prods) {
            for (const p of s.prods) {
              const venue = p.v || '';
              if (venue && !(existingVenues.get(titleLower)?.has(venue.toLowerCase()))) {
                data.push({ id: p.id, title: s.title, slug: p.id, status: s.status || 'closed', venue, category: p.cat });
                if (!existingVenues.has(titleLower)) existingVenues.set(titleLower, new Set());
                existingVenues.get(titleLower)!.add(venue.toLowerCase());
              }
            }
            continue;
          }
          const existingSet = existingVenues.get(titleLower);
          // Skip if no venue to differentiate, and title already exists
          if (!s.venue && existingSet) continue;
          // Skip if same venue already in data
          if (s.venue && existingSet?.has(s.venue.toLowerCase())) continue;
          data.push(s);
          if (s.venue) {
            if (!existingVenues.has(titleLower)) existingVenues.set(titleLower, new Set());
            existingVenues.get(titleLower)!.add(s.venue.toLowerCase());
          }
        }
      } catch { /* ignore parse errors */ }
    }
    showsRef.current = data;
    fuseRef.current = new FuseClass(data, {
      keys: [{ name: 'title', weight: 0.8 }, { name: 'venue', weight: 0.2 }],
      threshold: 0.4,
      ignoreLocation: true,
      minMatchCharLength: 2,
    });
  }, []);

  const matchShow = useCallback((name: string, venue?: string): { match: SearchShow | null; score: number } => {
    if (!fuseRef.current) return { match: null, score: 0 };
    const nameLower = name.toLowerCase();

    // Try exact title match — venue-aware when venue is provided
    const exactAll = showsRef.current.filter(s => s.title.toLowerCase() === nameLower);
    if (exactAll.length > 0) {
      if (venue) {
        const venueNorm = venue.toLowerCase().replace(/theatre|theater/gi, '').trim();
        const venueMatch = exactAll.find(s =>
          s.venue && s.venue.toLowerCase().replace(/theatre|theater/gi, '').trim().includes(venueNorm)
        );
        if (venueMatch) return { match: venueMatch, score: 1 };
        // No venue match among exact titles — fall through to Fuse for better matching
      } else {
        return { match: exactAll[0], score: 1 };
      }
    }

    // Fuzzy match
    const results = fuseRef.current.search(name, { limit: 5 });
    if (results.length === 0) {
      // Fall back to first exact match if Fuse found nothing
      if (exactAll.length > 0) return { match: exactAll[0], score: 1 };
      return { match: null, score: 0 };
    }

    // If venue provided, prefer matches with same venue
    if (venue) {
      const venueNorm = venue.toLowerCase().replace(/theatre|theater/gi, '').trim();
      const venueMatch = results.find(r =>
        r.item.venue && r.item.venue.toLowerCase().replace(/theatre|theater/gi, '').trim().includes(venueNorm)
      );
      if (venueMatch) return { match: venueMatch.item, score: 1 - (venueMatch.score || 0) };
    }

    const best = results[0];
    const score = 1 - (best.score || 0);
    // Penalize matches where titles don't share a containment relationship
    // e.g. "High Spirits" ≠ "Blithe Spirit" even though both contain "Spirit"
    const nameL = name.toLowerCase();
    const matchL = best.item.title.toLowerCase();
    const contained = nameL.includes(matchL) || matchL.includes(nameL);
    return { match: best.item, score: contained ? score : score * 0.6 };
  }, []);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setStep('matching');
    setError(null);

    try {
      const text = await file.text();
      const parsed: MezzExport = JSON.parse(text);

      if (!parsed.data?.diaryEntries) {
        throw new Error('Invalid Mezzanine export — missing data.diaryEntries');
      }

      await ensureSearchData();

      // Match diary entries
      // NOTE: We allow multiple diary entries for the same show (re-viewings).
      // Only skip if user already has a review for this show in their account.
      const matched: MatchedEntry[] = [];
      const diaryShowIds = new Set<string>();

      const today = new Date().toISOString().split('T')[0];

      for (const entry of parsed.data.diaryEntries) {
        const { match, score } = matchShow(
          entry.show.name,
          entry.production?.theater?.name
        );
        const showId = match?.id || '';
        const alreadyReviewed = showId ? existingReviewShowIds.has(showId) : false;
        const entryDate = entry.date ? entry.date.split('T')[0] : null;
        const hasRating = !!(entry.rating && entry.rating > 0);
        const isFuture = entryDate && entryDate > today;

        // Unrated future entries → watchlist with planned_date (not diary)
        if (!hasRating && isFuture) {
          const alreadyWatchlisted = showId ? existingWatchlistShowIds.has(showId) : false;
          matched.push({
            mezzName: entry.show.name,
            mezzRating: null,
            mezzDate: entryDate,
            mezzReview: null,
            match,
            matchScore: score,
            selected: !!match && score > 0.7 && !alreadyWatchlisted && !alreadyReviewed,
            type: 'watchlist',
            listName: 'Upcoming',
          });
        } else {
          matched.push({
            mezzName: entry.show.name,
            mezzRating: entry.rating || null,
            mezzDate: entryDate,
            mezzReview: entry.review || null,
            match,
            matchScore: score,
            selected: !!match && score > 0.7 && !alreadyReviewed,
            type: 'diary',
          });
        }

        if (showId) diaryShowIds.add(showId);
      }

      // Match wishlist entries
      for (const list of parsed.data.lists || []) {
        for (const show of list.shows) {
          const { match, score } = matchShow(show.name);
          const showId = match?.id || '';
          const alreadyWatchlisted = showId ? existingWatchlistShowIds.has(showId) : false;
          const alreadyInDiary = showId ? diaryShowIds.has(showId) : false;

          matched.push({
            mezzName: show.name,
            mezzRating: null,
            mezzDate: null,
            mezzReview: null,
            match,
            matchScore: score,
            selected: !!match && score > 0.7 && !alreadyWatchlisted && !alreadyInDiary,
            type: 'watchlist',
            listName: list.name,
          });
        }
      }

      setEntries(matched);
      setStep('preview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse file');
      setStep('upload');
    }
  }, [ensureSearchData, matchShow, existingReviewShowIds, existingWatchlistShowIds]);

  const diaryEntries = useMemo(() => entries.filter(e => e.type === 'diary'), [entries]);
  const watchlistEntries = useMemo(() => entries.filter(e => e.type === 'watchlist'), [entries]);
  const selectedDiary = useMemo(() => diaryEntries.filter(e => e.selected && e.match), [diaryEntries]);
  const selectedWatchlist = useMemo(() => watchlistEntries.filter(e => e.selected && e.match), [watchlistEntries]);
  const unmatchedDiary = useMemo(() => diaryEntries.filter(e => !e.match || e.matchScore <= 0.7).length, [diaryEntries]);
  const unmatchedWatchlist = useMemo(() => watchlistEntries.filter(e => !e.match || e.matchScore <= 0.7).length, [watchlistEntries]);
  const unmatchedCount = unmatchedDiary + unmatchedWatchlist;

  const toggleEntry = (index: number) => {
    setEntries(prev => prev.map((e, i) => i === index ? { ...e, selected: !e.selected } : e));
  };

  const handleImport = useCallback(async () => {
    setStep('importing');
    let imported = 0;
    let skipped = 0;
    let errors = 0;

    // Import diary entries (reviews) — only entries with a rating
    // Unrated entries become watchlist items (handled below)
    const unratedDiary: typeof selectedDiary = [];
    for (const entry of selectedDiary) {
      if (!entry.match) continue;
      if (!entry.mezzRating || entry.mezzRating <= 0) {
        // No rating — add to watchlist with planned_date instead
        unratedDiary.push(entry);
        continue;
      }
      try {
        // Mezzanine ratings are 1-5 with 0.5 steps — same as ours
        const { error: insertErr } = await supabaseRestInsert('reviews', {
          user_id: userId,
          show_id: entry.match.id,
          rating: entry.mezzRating,
          review_text: entry.mezzReview || null,
          date_seen: entry.mezzDate || null,
        });
        if (insertErr) {
          if (insertErr.code === '23505') { // unique constraint violation
            skipped++;
          } else {
            errors++;
          }
        } else {
          imported++;
        }
      } catch {
        errors++;
      }
    }

    // Import watchlist entries + unrated diary entries as watchlist items
    const allWatchlistEntries = [...selectedWatchlist, ...unratedDiary];
    for (const entry of allWatchlistEntries) {
      if (!entry.match) continue;
      try {
        const { error: insertErr } = await supabaseRestInsert('watchlist', {
          user_id: userId,
          show_id: entry.match.id,
          ...(entry.mezzDate && { planned_date: entry.mezzDate }),
        });
        if (insertErr) {
          if (insertErr.code === '23505') skipped++;
          else errors++;
        } else {
          imported++;
        }
      } catch {
        errors++;
      }
    }

    setImportStats({ imported, skipped, errors });
    setStep('done');
    if (imported > 0) onImportComplete();
  }, [selectedDiary, selectedWatchlist, userId, onImportComplete]);

  // Reset on close
  const handleClose = () => {
    setStep('closed');
    setEntries([]);
    setError(null);
    setImportStats({ imported: 0, skipped: 0, errors: 0 });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  if (step === 'closed') {
    return (
      <button
        type="button"
        onClick={() => setStep('upload')}
        className="text-xs text-gray-500 hover:text-white transition-colors flex items-center gap-1"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
        Import from Mezzanine
      </button>
    );
  }

  return (
    <Modal isOpen={true} onClose={handleClose} maxWidth="lg" bottomSheet ariaLabel="Import from Mezzanine">
      <div className="flex flex-col overflow-hidden max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <h3 className="text-base font-bold text-white">
            {step === 'upload' && 'Import from Mezzanine'}
            {step === 'matching' && 'Matching shows...'}
            {step === 'preview' && 'Review Import'}
            {step === 'importing' && 'Importing...'}
            {step === 'done' && 'Import Complete'}
          </h3>
          <ModalCloseButton onClick={handleClose} />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Upload step */}
          {step === 'upload' && (
            <div className="text-center py-6">
              <div className="text-3xl mb-3">📱</div>
              <p className="text-sm text-gray-300 mb-1">Export your data from Mezzanine:</p>
              <p className="text-xs text-gray-500 mb-6">Settings → Export Data → JSON</p>
              <label className="btn-primary text-sm gap-2 cursor-pointer">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                Choose JSON File
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleFileSelect}
                  className="hidden"
                />
              </label>
              {error && <p className="text-sm text-red-400 mt-4">{error}</p>}
            </div>
          )}

          {/* Matching step */}
          {step === 'matching' && (
            <div className="text-center py-12">
              <div className="animate-spin w-8 h-8 border-2 border-white/20 border-t-brand rounded-full mx-auto mb-4" />
              <p className="text-sm text-gray-400">Matching your shows...</p>
            </div>
          )}

          {/* Preview step */}
          {step === 'preview' && (
            <div>
              {/* Summary */}
              <div className="flex items-center gap-4 text-sm mb-4">
                <span className="text-green-400">{selectedDiary.length} diary entries</span>
                <span className="text-blue-400">{selectedWatchlist.length} watchlist</span>
                {unmatchedCount > 0 && <span className="text-yellow-400">{unmatchedCount} unmatched</span>}
              </div>

              {/* Diary entries */}
              {diaryEntries.length > 0 && (
                <div className="mb-4">
                  <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                    Diary ({selectedDiary.length}/{diaryEntries.length})
                  </h4>
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {diaryEntries.map((entry, i) => (
                      <ImportEntryRow key={`d-${i}`} entry={entry} index={i} onToggle={toggleEntry} />
                    ))}
                  </div>
                </div>
              )}

              {/* Watchlist entries */}
              {watchlistEntries.length > 0 && (
                <div className="mb-4">
                  <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                    Watchlist ({selectedWatchlist.length}/{watchlistEntries.length})
                  </h4>
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {watchlistEntries.map((entry, i) => {
                      const globalIndex = diaryEntries.length + i;
                      return <ImportEntryRow key={`w-${i}`} entry={entry} index={globalIndex} onToggle={toggleEntry} />;
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Importing step */}
          {step === 'importing' && (
            <div className="text-center py-12">
              <div className="animate-spin w-8 h-8 border-2 border-white/20 border-t-brand rounded-full mx-auto mb-4" />
              <p className="text-sm text-gray-400">Importing {selectedDiary.length + selectedWatchlist.length} entries...</p>
            </div>
          )}

          {/* Done step */}
          {step === 'done' && (
            <div className="text-center py-6">
              <div className="text-3xl mb-3">🎉</div>
              <p className="text-lg font-bold text-white mb-2">{importStats.imported} shows imported</p>
              {importStats.skipped > 0 && <p className="text-sm text-gray-400">{importStats.skipped} already existed (skipped)</p>}
              {importStats.errors > 0 && <p className="text-sm text-red-400">{importStats.errors} failed</p>}
            </div>
          )}
        </div>

        {/* Footer */}
        {step === 'preview' && (
          <div className="px-5 py-3 border-t border-white/10 flex justify-end gap-3">
            <button onClick={handleClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
            <button
              onClick={handleImport}
              disabled={selectedDiary.length + selectedWatchlist.length === 0}
              className="btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Import {selectedDiary.length + selectedWatchlist.length} Shows
            </button>
          </div>
        )}

        {step === 'done' && (
          <div className="px-5 py-3 border-t border-white/10 flex justify-end">
            <button
              onClick={handleClose}
              className="btn-primary text-sm"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ImportEntryRow({ entry, index, onToggle }: { entry: MatchedEntry; index: number; onToggle: (i: number) => void }) {
  const noMatch = !entry.match || entry.matchScore <= 0.7;
  return (
    <label className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors ${
      noMatch ? 'opacity-50' : entry.selected ? 'bg-white/5' : 'opacity-60'
    }`}>
      <input
        type="checkbox"
        checked={entry.selected}
        onChange={() => onToggle(index)}
        disabled={noMatch}
        className="w-3.5 h-3.5 rounded border-white/20 text-brand focus:ring-brand/50 bg-white/5"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-white truncate">{entry.mezzName}</span>
          {entry.mezzRating && (
            <span className="text-xs text-amber-400 flex-shrink-0">★ {entry.mezzRating}</span>
          )}
        </div>
        {entry.match && !noMatch ? (
          <div className="text-xs text-gray-500 truncate">→ {entry.match.title}</div>
        ) : (
          <div className="text-xs text-yellow-500">No match found</div>
        )}
      </div>
      {entry.listName && (
        <span className="text-xs text-gray-600 flex-shrink-0">{entry.listName}</span>
      )}
    </label>
  );
}
