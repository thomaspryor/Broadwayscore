'use client';

import { useState, useCallback, useMemo, useRef } from 'react';
import type Fuse from 'fuse.js';
import { supabaseRestInsert } from '@/lib/supabase-rest';
import { Modal, ModalCloseButton } from '@/components/show-cards';
import {
  acquireFromMezzanine,
  acquireFromShowScore,
  mergeDiaryShows,
  type ImportAcquireResult,
  type RawImportEntry,
} from '@/lib/show-import';
import {
  searchMezzanineCatalog,
  resolveMezzanineShow,
  stubRowFromCandidate,
  MEZZANINE_SEARCH_ERROR_COPY,
  type MezzanineCandidate,
} from '@/lib/mezzanine-search';
import { getMarketLabel } from '@/lib/market-utils';
import { marketLabel as diaryMarketLabel } from '@/lib/diary-show-types';

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
  /** Opening/closing dates (YYYY-MM-DD) for date-aware matching. */
  od?: string;
  cd?: string;
  /** True for diary-only (unscored) catalog entries — see mergeDiaryShows. */
  dy?: boolean;
  /** Production year (base catalog) — falls back to od's year for display. */
  year?: string;
  /** City for diary-catalog regional/international productions. */
  city?: string;
}

/** Short market label for a matched production — Broadway is the unlabeled
 *  default in search-shows.json (getMarketLabel's default covers it);
 *  diary-catalog regional/international entries are most useful identified
 *  by their city, falling back to the canonical diary market labels. */
function marketLabel(s: SearchShow): string {
  switch (s.category) {
    case undefined:
    case 'broadway':
    case 'off-broadway':
    case 'west-end':
    case 'off-west-end':
      return getMarketLabel(s.category);
    default:
      return s.city || diaryMarketLabel(s.category ?? null);
  }
}

/** "Broadway 2017 · Gerald Schoenfeld Theatre" — market + year + venue. */
function matchContext(s: SearchShow): string {
  const year = s.year || s.od?.slice(0, 4);
  return [[marketLabel(s), year].filter(Boolean).join(' '), s.venue].filter(Boolean).join(' · ');
}

/** Format a YYYY-MM-DD diary date without Date-parse timezone shifts. */
function formatDateSeen(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return iso;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[m - 1]} ${d}, ${y}`;
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
  /** Real match demoted only by the date-sanity guard (the user's date falls
   *  outside the production's run). Tickable with a caution label — a typo'd
   *  diary date must not make a genuinely-seen show unimportable. */
  dateSuspect: boolean;
  /** Matched show already has a rating/watchlist row in this account —
   *  deselected by default and labeled so the skip is self-explanatory. */
  alreadyOwned: boolean;
  type: 'diary' | 'watchlist';
  listName?: string;
  /** Mezzanine Show class objectId, when the source export carried one —
   *  lets the per-row live-lookup "find it" button resolve exactly instead
   *  of falling back to a fuzzy title search. */
  sourceMezzShowId?: string;
}

/** A "find it" result is either one of OUR merged-catalog productions
 *  (same title, e.g. a Met Opera season Mezzanine has no coverage of —
 *  card 3a5637c5) or a live Mezzanine catalog candidate. Picking a 'catalog'
 *  entry sets match directly (it's already a real show); picking a
 *  'mezzanine' entry still creates a user_show_stubs row. */
type FindItCandidate =
  | { source: 'catalog'; show: SearchShow }
  | { source: 'mezzanine'; candidate: MezzanineCandidate };

type LiveResolveState = { status: 'searching' } | { status: 'results'; candidates: FindItCandidate[] } | { status: 'empty' } | { status: 'error'; message: string };

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
    let data: SearchShow[] = await res.json();
    // Merge diary shows — expand multi-prod groups into individual entries and add
    // diary entries with distinct venues for venue-aware import matching.
    if (diaryRes?.ok) {
      try {
        const diaryData: SearchShow[] = await diaryRes.json();
        data = mergeDiaryShows(data, diaryData);
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

  /** Downgrade a match whose production can't have been running when the
   *  user saw it. History Boys logged in 2025 must not attach to the 2006
   *  Broadway run (Mezzanine import mismatches, 2026-07-14): a demoted match
   *  falls below the 0.7 bar and surfaces as "Not on Broadway Scorecard"
   *  instead of silently writing the wrong show. 90-day grace on both ends
   *  covers previews and lingering post-closing dates; shows without a
   *  closing date (open/unknown) are never demoted on the tail end. */
  const dateSanity = (candidate: SearchShow, dateSeen?: string | null): number => {
    if (!dateSeen) return 1;
    const seen = Date.parse(dateSeen);
    if (Number.isNaN(seen)) return 1;
    const GRACE = 90 * 24 * 3600 * 1000;
    if (candidate.od && seen < Date.parse(candidate.od) - GRACE) return 0.4;
    if (candidate.cd && seen > Date.parse(candidate.cd) + GRACE) return 0.4;
    return 1;
  };

  /** Normalize a title for comparison: fancy quotes/dashes → plain, & → and,
   *  accents folded, strip punctuation, collapse whitespace. Show Score
   *  renders titles with curly quotes and ampersands ('CATS: \u201cThe
   *  Jellicle Ball\u201d', 'Guys & Dolls') that broke both the exact-match
   *  and containment checks against our plain-ASCII catalog titles (owner
   *  import, 2026-07-14). Accents must fold BEFORE the [^a-z0-9]+ strip, or
   *  'La Boh\u00e8me' becomes 'la boh me' and matches nothing (owner import,
   *  2026-07-21) — mirrors normalizeQuery in
   *  supabase/functions/mezzanine-search/classify.mjs, kept in sync manually. */
  const normTitle = (t: string) =>
    t.toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u2018\u2019\u201a\u2032']/g, '')
      .replace(/[\u201c\u201d\u201e\u2033"]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

  const matchShow = useCallback((name: string, venue?: string, dateSeen?: string | null): { match: SearchShow | null; score: number; dateSuspect: boolean } => {
    if (!fuseRef.current) return { match: null, score: 0, dateSuspect: false };
    const nameNorm = normTitle(name);
    const withSanity = (match: SearchShow, raw: number) => {
      const sane = dateSanity(match, dateSeen);
      return { match, score: raw * sane, dateSuspect: sane < 1 && raw > 0.7 };
    };
    // Same title, multiple productions (revivals/transfers): pick the run the
    // user's date falls inside, else the one that opened closest to it. The
    // old exactAll[0] grabbed whichever production happened to be first in
    // the file — the root cause of the 2026-03-05 Mezzanine mismatches
    // (History Boys 2006, Prince of Broadway 2017, ...).
    const closestRun = (candidates: SearchShow[]): SearchShow => {
      if (!dateSeen || candidates.length < 2) return candidates[0];
      const seen = Date.parse(dateSeen);
      const distance = (s: SearchShow) => {
        if (!s.od) return 10 * 365 * 24 * 3600 * 1000; // undated: beats absurdly-far runs, loses to plausible ones
        const od = Date.parse(s.od);
        const cd = s.cd ? Date.parse(s.cd) : Number.POSITIVE_INFINITY;
        if (seen >= od && seen <= cd) return 0; // inside the run
        return Math.min(Math.abs(seen - od), Number.isFinite(cd) ? Math.abs(seen - cd) : Number.MAX_SAFE_INTEGER);
      };
      return [...candidates].sort((a, b) => distance(a) - distance(b))[0];
    };

    // Tier 1: exact normalized title. Tier 2: one title is a prefix of the
    // other ('Sweeney Todd' vs 'Sweeney Todd: The Demon Barber of Fleet
    // Street') — near-exact, still date/venue-disambiguated.
    let exactAll = showsRef.current.filter(s => normTitle(s.title) === nameNorm);
    let tierScore = 1;
    if (exactAll.length === 0 && nameNorm.length >= 8) {
      exactAll = showsRef.current.filter(s => {
        const c = normTitle(s.title);
        if (c.length < 8) return false;
        return c.startsWith(nameNorm + ' ') || nameNorm.startsWith(c + ' ');
      });
      tierScore = 0.85;
    }
    if (exactAll.length > 0) {
      if (venue) {
        // Leading 'the' stripped on both sides: 'The Metropolitan Opera'
        // must match venue 'Metropolitan Opera House'.
        const vnorm = (v: string) => v.toLowerCase().replace(/theatre|theater/gi, '').replace(/^the\s+/, '').trim();
        const venueNorm = vnorm(venue);
        // Short normalized names must match exactly — substring matching let
        // 'The Duke' (→'duke') claim "Duke of York's" (review finding).
        const venueMatch = exactAll.find(s => {
          if (!s.venue) return false;
          const cand = vnorm(s.venue);
          return venueNorm.length < 5 || cand.length < 5 ? cand === venueNorm : cand.includes(venueNorm);
        });
        if (venueMatch) return withSanity(venueMatch, tierScore);
        // No venue agreement — the date is the next-best disambiguator among
        // same-title productions (falling through to Fuse here re-picked
        // whatever fuzzy ranked first, defeating the run selection).
        return withSanity(closestRun(exactAll), tierScore * 0.95);
      }
      return withSanity(closestRun(exactAll), tierScore);
    }

    // Fuzzy match
    const results = fuseRef.current.search(name, { limit: 5 });
    if (results.length === 0) {
      // Fall back to first exact match if Fuse found nothing
      if (exactAll.length > 0) return withSanity(exactAll[0], 1);
      return { match: null, score: 0, dateSuspect: false };
    }

    // If venue provided, prefer matches with same venue
    if (venue) {
      const venueNorm = venue.toLowerCase().replace(/theatre|theater/gi, '').trim();
      const venueMatch = results.find(r =>
        r.item.venue && r.item.venue.toLowerCase().replace(/theatre|theater/gi, '').trim().includes(venueNorm)
      );
      if (venueMatch) return withSanity(venueMatch.item, 1 - (venueMatch.score || 0));
    }

    const best = results[0];
    const score = 1 - (best.score || 0);
    // Penalize matches where titles don't share a containment relationship
    // e.g. "High Spirits" ≠ "Blithe Spirit" even though both contain "Spirit"
    const nameL = nameNorm;
    const matchL = normTitle(best.item.title);
    const contained = nameL.includes(matchL) || matchL.includes(nameL);
    return withSanity(best.item, contained ? score : score * 0.6);
  }, []);

  /** Match raw source entries against our catalog and apply selection
   *  defaults (auto-select confident matches not already in the account). */
  const matchAndPreview = useCallback(async (acquired: ImportAcquireResult, sourceId: ImportSourceId) => {
    await ensureSearchData();
    const matched: MatchedEntry[] = [];
    const diaryShowIds = new Set<string>();
    // Self-heal loop (Notion 39d637c5): every row that doesn't confidently
    // match gets logged so the nightly resolver can look it up on Mezzanine
    // and grow diary-shows.json — the catalog fixes itself instead of
    // staying frozen at its snapshot date. Best-effort: never blocks import.
    const unmatchedRows: { raw: RawImportEntry; matchScore: number; dateSuspect: boolean }[] = [];

    for (const raw of acquired.entries.filter(e => e.kind === 'diary')) {
      const { match, score, dateSuspect } = matchShow(raw.title, raw.venue || undefined, raw.date);
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
        dateSuspect,
        type: 'diary',
        sourceMezzShowId: raw.mezzShowId,
      });
      if (showId) diaryShowIds.add(showId);
      if (!match || (score <= 0.7 && !dateSuspect)) unmatchedRows.push({ raw, matchScore: score, dateSuspect });
    }

    for (const raw of acquired.entries.filter(e => e.kind === 'watchlist')) {
      const { match, score, dateSuspect } = matchShow(raw.title, raw.venue || undefined, raw.date);
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
        dateSuspect,
        type: 'watchlist',
        listName: raw.listName,
        sourceMezzShowId: raw.mezzShowId,
      });
      if (!match || (score <= 0.7 && !dateSuspect)) unmatchedRows.push({ raw, matchScore: score, dateSuspect });
    }

    setEntries(matched);
    setNotices(acquired.notices);
    setStep('preview');

    // Fire-and-forget: don't await, don't block the preview step on this.
    // Mock mode (Playwright QA) must not feed fixture titles to the nightly
    // Mezzanine resolver.
    for (const { raw } of userId === 'mock-user' ? [] : unmatchedRows) {
      supabaseRestInsert('unmatched_imports', {
        user_id: userId,
        source: sourceId,
        title: raw.title,
        venue: raw.venue,
        date_seen: raw.date,
        mezz_show_id: raw.mezzShowId || null,
      }).catch(() => {}); // best-effort logging — an insert failure must never surface to the user
    }
  }, [ensureSearchData, matchShow, existingReviewShowIds, existingWatchlistShowIds, userId]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Clear immediately so re-selecting the same filename after a parse error
    // still fires a change event.
    e.target.value = '';
    setStep('matching');
    setError(null);
    try {
      await matchAndPreview(await acquireFromMezzanine(file), 'mezzanine');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse file');
      setStep('source');
    }
  }, [matchAndPreview]);

  const handleShowScoreFetch = useCallback(async () => {
    setStep('matching');
    setError(null);
    try {
      await matchAndPreview(await acquireFromShowScore(profileInput), 'show-score');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed — try again.');
      setStep('source');
    }
  }, [matchAndPreview, profileInput]);

  // Indexed views: rows carry their index into `entries` so toggleEntry works
  // regardless of how the display lists are filtered/split (the old
  // "diaryEntries.length + i" offset math broke as soon as sections stopped
  // being a straight partition of `entries`).
  const indexedEntries = useMemo(() => entries.map((entry, idx) => ({ entry, idx })), [entries]);
  const isUnmatched = (e: MatchedEntry) => !e.match || (e.matchScore <= 0.7 && !e.dateSuspect);
  // Date-mismatch rows get their own section (owner request, 2026-07-21):
  // buried in the Diary list they were unfindable. Membership is by the
  // dateSuspect flag, so ticking "import anyway" keeps the row here, while
  // picking a different production via find-it (which clears the flag)
  // graduates it into the normal Diary/Watchlist list.
  // alreadyOwned rows are excluded even when dateSuspect: they're skipped as
  // duplicates and belong under "already in your shows" — showing them here
  // too made the same row read as both "skipped" and "needs a date check"
  // (ship-check finding, 2026-07-21).
  const dateSuspectRows = useMemo(() => indexedEntries.filter(({ entry }) => entry.dateSuspect && !entry.alreadyOwned && !isUnmatched(entry)), [indexedEntries]);
  const diaryRows = useMemo(() => indexedEntries.filter(({ entry }) => entry.type === 'diary' && (!entry.dateSuspect || entry.alreadyOwned) && !isUnmatched(entry)), [indexedEntries]);
  const watchlistRows = useMemo(() => indexedEntries.filter(({ entry }) => entry.type === 'watchlist' && (!entry.dateSuspect || entry.alreadyOwned) && !isUnmatched(entry)), [indexedEntries]);
  // Grouped instead of scattered through the main list, and re-shown on the
  // done step: these are the user's to-do list for manual adds (owner
  // request, 2026-07-14).
  const unmatchedRows = useMemo(() => indexedEntries.filter(({ entry }) => isUnmatched(entry)), [indexedEntries]);
  const diaryEntries = useMemo(() => entries.filter(e => e.type === 'diary'), [entries]);
  const watchlistEntries = useMemo(() => entries.filter(e => e.type === 'watchlist'), [entries]);
  const selectedDiary = useMemo(() => diaryEntries.filter(e => e.selected && e.match), [diaryEntries]);
  const selectedWatchlist = useMemo(() => watchlistEntries.filter(e => e.selected && e.match), [watchlistEntries]);
  const unmatchedDiary = useMemo(() => diaryEntries.filter(e => !e.match || (e.matchScore <= 0.7 && !e.dateSuspect)).length, [diaryEntries]);
  const unmatchedWatchlist = useMemo(() => watchlistEntries.filter(e => !e.match || (e.matchScore <= 0.7 && !e.dateSuspect)).length, [watchlistEntries]);
  const unmatchedCount = unmatchedDiary + unmatchedWatchlist;
  // The summary must PARTITION matched entries — selected + skipped-owned +
  // manually-unticked + unmatched = total — under every toggle state, or the
  // headline numbers stop adding up (second-opinion review, 2026-07-13):
  // a re-ticked owned row must leave the skipped count, and a manually
  // unticked row must land in a visible bucket instead of vanishing.
  const skippedOwnedCount = useMemo(
    () => entries.filter(e => e.alreadyOwned && !e.selected && e.match && (e.matchScore > 0.7 || e.dateSuspect)).length,
    [entries],
  );
  // Kept as entries (not a bare count) so the summary can NAME the unticked
  // shows — a "2 not selected" with no titles sent the owner scrolling a
  // 98-row list looking for them (2026-07-21).
  const untickedEntries = useMemo(
    () => entries.filter(e => !e.alreadyOwned && !e.selected && e.match && (e.matchScore > 0.7 || e.dateSuspect)),
    [entries],
  );
  const untickedCount = untickedEntries.length;

  const toggleEntry = (index: number) => {
    setEntries(prev => prev.map((e, i) => i === index ? { ...e, selected: !e.selected } : e));
  };

  // Per-row "find it" live lookup for rows that missed the local catalog
  // match (card 174): Mezzanine-source rows carry sourceMezzShowId for exact
  // resolution; Show Score rows fall back to a normalized-title search.
  const [liveResolve, setLiveResolve] = useState<Record<number, LiveResolveState>>({});

  const findItForRow = useCallback(async (index: number) => {
    const entry = entries[index];
    if (!entry) return;
    setLiveResolve(prev => ({ ...prev, [index]: { status: 'searching' } }));
    try {
      await ensureSearchData();
    } catch (err) {
      // Without this, a failed catalog fetch stranded the row on "Searching…"
      // forever — the "Find it" button only re-renders when !liveResolve.
      setLiveResolve(prev => ({ ...prev, [index]: { status: 'error', message: err instanceof Error ? err.message : MEZZANINE_SEARCH_ERROR_COPY.internal } }));
      return;
    }
    // Our own merged catalog first — covers productions Mezzanine's
    // user-generated database has no coverage of at all (e.g. the Met Opera
    // has zero Mezzanine productions, card 3a5637c5) — shown above Mezzanine
    // results. Excludes the show already assigned as entry.match so a
    // dateSuspect row doesn't just re-offer its own current match.
    const nameNorm = normTitle(entry.sourceTitle);
    const currentMatchId = entry.match?.id;
    const ownShows = showsRef.current.filter(s => normTitle(s.title) === nameNorm && s.id !== currentMatchId);
    const ownIds = new Set(ownShows.map(s => s.id));
    const ownCandidates: FindItCandidate[] = ownShows.map(show => ({ source: 'catalog', show }));

    let mezzCandidates: FindItCandidate[] = [];
    try {
      const mezzResults = entry.sourceMezzShowId
        ? await resolveMezzanineShow(entry.sourceMezzShowId)
        : await searchMezzanineCatalog(entry.sourceTitle);
      mezzCandidates = mezzResults.filter(c => !ownIds.has(c.id)).map(candidate => ({ source: 'mezzanine', candidate }));
    } catch (err) {
      // Own-catalog candidates are still usable even if the wider Mezzanine
      // search failed — only surface the error when we have nothing to show.
      if (ownCandidates.length === 0) {
        setLiveResolve(prev => ({ ...prev, [index]: { status: 'error', message: err instanceof Error ? err.message : MEZZANINE_SEARCH_ERROR_COPY.internal } }));
        return;
      }
    }

    const candidates = [...ownCandidates, ...mezzCandidates];
    setLiveResolve(prev => ({ ...prev, [index]: candidates.length > 0 ? { status: 'results', candidates } : { status: 'empty' } }));
  }, [entries, ensureSearchData]);

  const pickCandidateForRow = useCallback((index: number, candidate: FindItCandidate) => {
    if (candidate.source === 'catalog') {
      const show = candidate.show;
      // Mirror matchAndPreview's alreadyOwned check (line ~304/326) — a
      // picked catalog show can be one the user already reviewed/watchlisted,
      // and without this it displays as a fresh importable row.
      const alreadyOwned = existingReviewShowIds.has(show.id) || existingWatchlistShowIds.has(show.id);
      setEntries(prev => prev.map((e, i) => i === index ? {
        ...e,
        match: show,
        matchScore: 1,
        selected: !alreadyOwned,
        alreadyOwned,
        dateSuspect: false,
      } : e));
      setLiveResolve(prev => { const next = { ...prev }; delete next[index]; return next; });
      return;
    }
    const mezz = candidate.candidate;
    supabaseRestInsert('user_show_stubs', stubRowFromCandidate(mezz, userId)).catch(() => {});
    setEntries(prev => prev.map((e, i) => i === index ? {
      ...e,
      match: {
        id: mezz.id, title: mezz.title, slug: mezz.id, status: 'closed', dy: true,
        category: mezz.category, venue: mezz.venue || undefined,
        city: mezz.city || undefined, od: mezz.openingDate || undefined,
      },
      matchScore: 1,
      selected: true,
      dateSuspect: false,
    } : e));
    setLiveResolve(prev => { const next = { ...prev }; delete next[index]; return next; });
  }, [userId, existingReviewShowIds, existingWatchlistShowIds]);

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
    <Modal isOpen={true} onClose={handleClose} maxWidth="xl" bottomSheet ariaLabel="Import shows">
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
                {skippedOwnedCount > 0 && <span className="text-gray-400">{skippedOwnedCount} skipped — already in your shows</span>}
                {untickedCount > 0 && (
                  <span className="text-gray-400">
                    {untickedCount} not selected — {untickedEntries.slice(0, 3).map(e => e.sourceTitle).join(', ')}
                    {untickedCount > 3 ? ` +${untickedCount - 3} more` : ''}
                  </span>
                )}
                {unmatchedCount > 0 && <span className="text-yellow-400">{unmatchedCount} not on Broadway Scorecard</span>}
              </div>
              {notices.map((n, i) => (
                <p key={i} className="text-xs text-yellow-500 mb-1">{n}</p>
              ))}
              <p className="text-xs text-gray-600 mb-4">
                Imported ratings are private until you choose to share them.
                {source === 'show-score' && ' Show Score scores convert to the nearest half-star.'}
                {selectedDiary.filter(e => !e.sourceDate).length > 0 &&
                  ` ${selectedDiary.filter(e => !e.sourceDate).length} of your reviews have no date — they'll land in a "No date" section where you can add one.`}
              </p>

              {/* Date-mismatch rows: own section, with the WHY and a way out
                  (owner request, 2026-07-21 — buried in the Diary list they
                  were unfindable and the skip looked arbitrary). */}
              {dateSuspectRows.length > 0 && (
                <div className="mb-4">
                  <h4 className="text-xs font-bold text-yellow-500 uppercase tracking-wider mb-1">
                    Not selected — date mismatch ({dateSuspectRows.length})
                  </h4>
                  <p className="text-xs text-gray-500 mb-2">
                    The date you logged falls outside this production&apos;s run, so we didn&apos;t
                    auto-select it — you may have seen a different production (a tour or revival)
                    of the same title. Tick the box to import into the matched production anyway,
                    or use &quot;Find the production I saw&quot; to pick the right one.
                  </p>
                  <div className="space-y-1 max-h-48 sm:max-h-[35vh] overflow-y-auto">
                    {dateSuspectRows.map(({ entry, idx }) => (
                      <ImportEntryRow
                        key={`s-${idx}`}
                        entry={entry}
                        index={idx}
                        onToggle={toggleEntry}
                        liveResolve={liveResolve[idx]}
                        onFindIt={findItForRow}
                        onPickCandidate={pickCandidateForRow}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Diary entries */}
              {diaryRows.length > 0 && (
                <div className="mb-4">
                  <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                    Diary — {diaryRows.filter(({ entry }) => entry.selected).length} of {diaryRows.length} selected
                  </h4>
                  <div className="space-y-1 max-h-48 sm:max-h-[40vh] overflow-y-auto">
                    {diaryRows.map(({ entry, idx }) => (
                      <ImportEntryRow key={`d-${idx}`} entry={entry} index={idx} onToggle={toggleEntry} />
                    ))}
                  </div>
                </div>
              )}

              {/* Watchlist entries */}
              {watchlistRows.length > 0 && (
                <div className="mb-4">
                  <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                    Watchlist — {watchlistRows.filter(({ entry }) => entry.selected).length} of {watchlistRows.length} selected
                  </h4>
                  <div className="space-y-1 max-h-32 sm:max-h-[30vh] overflow-y-auto">
                    {watchlistRows.map(({ entry, idx }) => (
                      <ImportEntryRow key={`w-${idx}`} entry={entry} index={idx} onToggle={toggleEntry} />
                    ))}
                  </div>
                </div>
              )}

              {/* Unmatched — grouped so they're findable, not scattered */}
              {unmatchedRows.length > 0 && (
                <div className="mb-4">
                  <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                    Not on Broadway Scorecard ({unmatchedRows.length})
                  </h4>
                  <div className="space-y-1 max-h-64 overflow-y-auto">
                    {unmatchedRows.map(({ entry, idx }) => (
                      <ImportEntryRow
                        key={`u-${idx}`}
                        entry={entry}
                        index={idx}
                        onToggle={toggleEntry}
                        liveResolve={liveResolve[idx]}
                        onFindIt={findItForRow}
                        onPickCandidate={pickCandidateForRow}
                      />
                    ))}
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
            <div className="py-6">
              <div className="text-center">
                <div className="text-3xl mb-3">🎉</div>
                <p className="text-lg font-bold text-white mb-2">{importStats.imported} shows imported</p>
                {importStats.skipped > 0 && <p className="text-sm text-gray-400">{importStats.skipped} already existed (skipped)</p>}
                {importStats.errors > 0 && <p className="text-sm text-red-400">{importStats.errors} failed</p>}
              </div>
              {/* The unmatched list is the user's takeaway: which of their
                  shows couldn't come along, so they can search for them
                  manually or tell us to add them. */}
              {unmatchedRows.length > 0 && (
                <div className="mt-5 text-left">
                  <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">
                    Not imported — {unmatchedRows.length} show{unmatchedRows.length === 1 ? '' : 's'} we couldn&apos;t find on Broadway Scorecard
                  </h4>
                  <ul className="space-y-1 max-h-40 overflow-y-auto text-sm text-gray-300">
                    {unmatchedRows.map(({ entry, idx }) => (
                      <li key={`nu-${idx}`} className="px-2.5 py-1 rounded bg-white/5 flex items-baseline gap-2">
                        <span className="truncate">{entry.sourceTitle}</span>
                        {entry.sourceRating && (
                          <span className="text-xs text-amber-400 flex-shrink-0">★ {entry.sourceRating}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-gray-500 mt-2">
                    Try the <span className="text-gray-300">Add show</span> search (spellings sometimes differ), or{' '}
                    <a href="/feedback" className="text-brand hover:underline">ask us to add them</a>.
                  </p>
                </div>
              )}
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
              Import {selectedDiary.length + selectedWatchlist.length} Show{selectedDiary.length + selectedWatchlist.length === 1 ? '' : 's'}
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

function ImportEntryRow({ entry, index, onToggle, liveResolve, onFindIt, onPickCandidate }: {
  entry: MatchedEntry;
  index: number;
  onToggle: (i: number) => void;
  /** Only present on rows rendered in the "Not on Broadway Scorecard" list. */
  liveResolve?: LiveResolveState;
  onFindIt?: (index: number) => void;
  onPickCandidate?: (index: number, candidate: FindItCandidate) => void;
}) {
  const noMatch = !entry.match || (entry.matchScore <= 0.7 && !entry.dateSuspect);
  return (
    <div>
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
            <span className="text-gray-600"> · {matchContext(entry.match)}</span>
            {entry.sourceDate && (
              <span className="text-gray-600"> · you logged {formatDateSeen(entry.sourceDate)}</span>
            )}
            {entry.alreadyOwned && (
              <span className="text-gray-600"> · already in your shows{entry.selected ? ' — will add another viewing' : ''}</span>
            )}
            {entry.dateSuspect && (
              <span className="text-yellow-600"> · date is outside this run</span>
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
    {(noMatch || entry.dateSuspect) && onFindIt && (
      <div className="pl-8 pb-1.5 -mt-1">
        {(!liveResolve) && (
          <button type="button" onClick={() => onFindIt(index)} className="text-xs text-brand hover:underline">
            {noMatch ? 'Find it' : 'Find the production I saw'}
          </button>
        )}
        {liveResolve?.status === 'searching' && (
          <p className="text-xs text-gray-500">Searching the wider catalog...</p>
        )}
        {liveResolve?.status === 'empty' && (
          <p className="text-xs text-gray-500">Not found in the wider catalog either.</p>
        )}
        {liveResolve?.status === 'error' && (
          <div>
            <p className="text-xs text-red-400">{liveResolve.message}</p>
            <button type="button" onClick={() => onFindIt(index)} className="text-xs text-brand hover:underline">Try again</button>
          </div>
        )}
        {liveResolve?.status === 'results' && (
          <div className="space-y-1 mt-1">
            {liveResolve.candidates.map(fic => {
              const isCatalog = fic.source === 'catalog';
              const title = isCatalog ? fic.show.title : fic.candidate.title;
              const venue = isCatalog ? fic.show.venue : fic.candidate.venue;
              const year = isCatalog ? (fic.show.year || fic.show.od?.slice(0, 4)) : fic.candidate.openingDate?.slice(0, 4);
              const city = isCatalog ? fic.show.city : fic.candidate.city;
              const ratingsCount = isCatalog ? 0 : (fic.candidate.ratingsCount ?? 0);
              const key = isCatalog ? `catalog:${fic.show.id}` : `mezz:${fic.candidate.id}`;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onPickCandidate?.(index, fic)}
                  className="block w-full text-left text-xs text-gray-300 hover:text-white hover:bg-white/5 rounded px-1.5 py-1"
                >
                  {title}{venue ? ` — ${venue}` : ''}{year ? ` (${year})` : ''}
                  {isCatalog && <span className="text-gray-500"> · on Broadway Scorecard</span>}
                  {ratingsCount > 0 && <span className="text-gray-500"> · {ratingsCount} ratings</span>}
                  {city && <span className="text-gray-500"> · {city}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    )}
    </div>
  );
}
