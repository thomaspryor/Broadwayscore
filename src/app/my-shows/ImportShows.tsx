'use client';

import { useState, useCallback, useMemo, useRef } from 'react';
import type Fuse from 'fuse.js';
import { supabaseRestInsert } from '@/lib/supabase-rest';
import { Modal, ModalCloseButton } from '@/components/show-cards';
import {
  acquireFromMezzanine,
  acquireFromShowScore,
  type ImportAcquireResult,
} from '@/lib/show-import';

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
  sourceTitle: string;
  sourceRating: number | null;
  /** Original source-scale score (Show Score 0–100) for preview display. */
  sourceScore: number | null;
  sourceDate: string | null;
  sourceReview: string | null;
  match: SearchShow | null;
  matchScore: number;
  selected: boolean;
  /** Matched show already has a rating/watchlist row in this account —
   *  deselected by default and labeled so the skip is self-explanatory. */
  alreadyOwned: boolean;
  type: 'diary' | 'watchlist';
  listName?: string;
}

type ImportSourceId = 'mezzanine' | 'show-score';
type ImportStep = 'closed' | 'source' | 'matching' | 'preview' | 'importing' | 'done';

interface ImportShowsProps {
  userId: string;
  existingReviewShowIds: Set<string>;
  existingWatchlistShowIds: Set<string>;
  onImportComplete: () => void;
}

export default function ImportShows({
  userId,
  existingReviewShowIds,
  existingWatchlistShowIds,
  onImportComplete,
}: ImportShowsProps) {
  const [step, setStep] = useState<ImportStep>('closed');
  const [source, setSource] = useState<ImportSourceId>('show-score');
  const [entries, setEntries] = useState<MatchedEntry[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const [profileInput, setProfileInput] = useState('');
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

  /** Match raw source entries against our catalog and apply selection
   *  defaults (auto-select confident matches not already in the account). */
  const matchAndPreview = useCallback(async (acquired: ImportAcquireResult) => {
    await ensureSearchData();
    const matched: MatchedEntry[] = [];
    const diaryShowIds = new Set<string>();

    for (const raw of acquired.entries.filter(e => e.kind === 'diary')) {
      const { match, score } = matchShow(raw.title, raw.venue || undefined);
      const showId = match?.id || '';
      const alreadyReviewed = showId ? existingReviewShowIds.has(showId) : false;
      matched.push({
        sourceTitle: raw.title,
        sourceRating: raw.rating,
        sourceScore: raw.sourceScore,
        sourceDate: raw.date,
        sourceReview: raw.reviewText,
        match,
        matchScore: score,
        selected: !!match && score > 0.7 && !alreadyReviewed,
        alreadyOwned: alreadyReviewed,
        type: 'diary',
      });
      if (showId) diaryShowIds.add(showId);
    }

    for (const raw of acquired.entries.filter(e => e.kind === 'watchlist')) {
      const { match, score } = matchShow(raw.title, raw.venue || undefined);
      const showId = match?.id || '';
      const alreadyWatchlisted = showId ? existingWatchlistShowIds.has(showId) : false;
      const alreadyReviewed = showId ? existingReviewShowIds.has(showId) : false;
      const alreadyInDiary = showId ? diaryShowIds.has(showId) : false;
      // Parity with the original Mezzanine import: diary-derived entries
      // (unrated future viewings) dedupe against reviews; list-based entries
      // dedupe against this batch's diary picks.
      const autoSelect = raw.fromDiary
        ? !alreadyWatchlisted && !alreadyReviewed
        : !alreadyWatchlisted && !alreadyInDiary;
      matched.push({
        sourceTitle: raw.title,
        sourceRating: null,
        sourceScore: null,
        sourceDate: raw.date,
        sourceReview: null,
        match,
        matchScore: score,
        selected: !!match && score > 0.7 && autoSelect,
        alreadyOwned: alreadyWatchlisted || (raw.fromDiary ? alreadyReviewed : alreadyInDiary),
        type: 'watchlist',
        listName: raw.listName,
      });
    }

    setEntries(matched);
    setNotices(acquired.notices);
    setStep('preview');
  }, [ensureSearchData, matchShow, existingReviewShowIds, existingWatchlistShowIds]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Clear immediately so re-selecting the same filename after a parse error
    // still fires a change event.
    e.target.value = '';
    setStep('matching');
    setError(null);
    try {
      await matchAndPreview(await acquireFromMezzanine(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse file');
      setStep('source');
    }
  }, [matchAndPreview]);

  const handleShowScoreFetch = useCallback(async () => {
    setStep('matching');
    setError(null);
    try {
      await matchAndPreview(await acquireFromShowScore(profileInput));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed — try again.');
      setStep('source');
    }
  }, [matchAndPreview, profileInput]);

  const diaryEntries = useMemo(() => entries.filter(e => e.type === 'diary'), [entries]);
  const watchlistEntries = useMemo(() => entries.filter(e => e.type === 'watchlist'), [entries]);
  const selectedDiary = useMemo(() => diaryEntries.filter(e => e.selected && e.match), [diaryEntries]);
  const selectedWatchlist = useMemo(() => watchlistEntries.filter(e => e.selected && e.match), [watchlistEntries]);
  const unmatchedDiary = useMemo(() => diaryEntries.filter(e => !e.match || e.matchScore <= 0.7).length, [diaryEntries]);
  const unmatchedWatchlist = useMemo(() => watchlistEntries.filter(e => !e.match || e.matchScore <= 0.7).length, [watchlistEntries]);
  const unmatchedCount = unmatchedDiary + unmatchedWatchlist;
  const alreadyOwnedCount = useMemo(
    () => entries.filter(e => e.alreadyOwned && e.match && e.matchScore > 0.7).length,
    [entries],
  );

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
      if (!entry.sourceRating || entry.sourceRating <= 0) {
        // No rating — add to watchlist with planned_date instead
        unratedDiary.push(entry);
        continue;
      }
      try {
        const { error: insertErr } = await supabaseRestInsert('reviews', {
          user_id: userId,
          show_id: entry.match.id,
          rating: entry.sourceRating,
          review_text: entry.sourceReview || null,
          date_seen: entry.sourceDate || null,
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
          ...(entry.sourceDate && { planned_date: entry.sourceDate }),
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
    setNotices([]);
    setProfileInput('');
    setError(null);
    setImportStats({ imported: 0, skipped: 0, errors: 0 });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  if (step === 'closed') {
    return (
      <button
        type="button"
        onClick={() => setStep('source')}
        className="text-xs text-gray-500 hover:text-white transition-colors flex items-center gap-1"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
        Import from Show Score or Mezzanine
      </button>
    );
  }

  return (
    <Modal isOpen={true} onClose={handleClose} maxWidth="lg" bottomSheet ariaLabel="Import shows">
      <div className="flex flex-col overflow-hidden max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <h3 className="text-base font-bold text-white">
            {step === 'source' && 'Import your shows'}
            {step === 'matching' && (source === 'show-score' ? 'Fetching your profile...' : 'Matching shows...')}
            {step === 'preview' && 'Review Import'}
            {step === 'importing' && 'Importing...'}
            {step === 'done' && 'Import Complete'}
          </h3>
          <ModalCloseButton onClick={handleClose} />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Source-select step */}
          {step === 'source' && (
            <div className="space-y-6 py-2">
              {/* Show Score */}
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-lg">🎭</span>
                  <span className="text-sm font-bold text-white">Show Score</span>
                </div>
                <p className="text-xs text-gray-500 mb-2">
                  Paste your public profile link — your reviews and ratings import directly. No password needed.
                  Find it on show-score.com: tap your profile picture, then copy the page address.
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={profileInput}
                    onChange={(e) => setProfileInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && profileInput.trim()) { setSource('show-score'); handleShowScoreFetch(); } }}
                    placeholder="show-score.com/member/your-name"
                    className="flex-1 min-w-0 px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:border-brand/50"
                  />
                  <button
                    onClick={() => { setSource('show-score'); handleShowScoreFetch(); }}
                    disabled={!profileInput.trim()}
                    className="btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                  >
                    Import
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-white/10" />
                <span className="text-xs text-gray-600">or</span>
                <div className="flex-1 h-px bg-white/10" />
              </div>

              {/* Mezzanine */}
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-lg">📱</span>
                  <span className="text-sm font-bold text-white">Mezzanine</span>
                </div>
                <p className="text-xs text-gray-500 mb-2">In the app: Settings → Export Data → JSON, then upload the file.</p>
                <label className="btn-secondary text-sm gap-2 cursor-pointer inline-flex items-center">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  Choose JSON File
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json"
                    onChange={(e) => { setSource('mezzanine'); handleFileSelect(e); }}
                    className="hidden"
                  />
                </label>
              </div>

              {error && <p className="text-sm text-red-400">{error}</p>}
            </div>
          )}

          {/* Matching step */}
          {step === 'matching' && (
            <div className="text-center py-12">
              <div className="animate-spin w-8 h-8 border-2 border-white/20 border-t-brand rounded-full mx-auto mb-4" />
              <p className="text-sm text-gray-400">
                {source === 'show-score' ? 'Fetching and matching your Show Score reviews...' : 'Matching your shows...'}
              </p>
            </div>
          )}

          {/* Preview step */}
          {step === 'preview' && (
            <div>
              {/* Summary — spell out what will happen so the user never has to
                  reconcile the counts themselves (owner confusion, 2026-07-13:
                  "is it adding 37 shows, or 8?"). */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm mb-2">
                <span className="text-green-400">{selectedDiary.length + selectedWatchlist.length} selected to import</span>
                {alreadyOwnedCount > 0 && <span className="text-gray-400">{alreadyOwnedCount} skipped — already in your shows</span>}
                {unmatchedCount > 0 && <span className="text-yellow-400">{unmatchedCount} not on Broadway Scorecard</span>}
              </div>
              {notices.map((n, i) => (
                <p key={i} className="text-xs text-yellow-500 mb-1">{n}</p>
              ))}
              <p className="text-xs text-gray-600 mb-4">
                Imported ratings are private until you choose to share them.
                {source === 'show-score' && ' Show Score scores convert to the nearest half-star.'}
              </p>

              {/* Diary entries */}
              {diaryEntries.length > 0 && (
                <div className="mb-4">
                  <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                    Diary — {selectedDiary.length} of {diaryEntries.length} selected
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
                    Watchlist — {selectedWatchlist.length} of {watchlistEntries.length} selected
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
          <span className="text-xs text-white truncate">{entry.sourceTitle}</span>
          {entry.sourceRating ? (
            <span className="text-xs text-amber-400 flex-shrink-0">
              {entry.sourceScore !== null ? `${entry.sourceScore} → ` : ''}★ {entry.sourceRating}
            </span>
          ) : entry.type === 'diary' ? (
            // Unrated diary entries import into the watchlist, not the diary —
            // say so instead of letting the "diary" section header mislead.
            <span className="text-xs text-gray-600 flex-shrink-0">no rating → watchlist</span>
          ) : null}
        </div>
        {entry.match && !noMatch ? (
          <div className="text-xs text-gray-500 truncate">
            → {entry.match.title}
            {entry.alreadyOwned && (
              <span className="text-gray-600"> · already in your shows{entry.selected ? ' — will add another viewing' : ''}</span>
            )}
          </div>
        ) : (
          <div className="text-xs text-yellow-500">Not on Broadway Scorecard</div>
        )}
      </div>
      {entry.listName && (
        <span className="text-xs text-gray-600 flex-shrink-0">{entry.listName}</span>
      )}
    </label>
  );
}
