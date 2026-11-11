'use client';

/**
 * One-time, optional setup for a brand-new account (BRO-4619, reshaped by
 * BRO-6917 Part 4). Opened by WelcomeGate after claim_onboarding() succeeds,
 * and only after a Sign in button sign-up. Three skippable steps:
 *   shows — tap the shows you've seen (stars optional), per market, or search
 *   want  — tap the shows you want to see (watchlist)
 *   done  — where to go next
 * A side panel on desktop, the whole screen on a phone (quizLayoutFor). The
 * old import step is gone: import stays on My Shows.
 * Decisions live in src/lib/welcome-onboarding.ts and
 * src/lib/web-signup-onboarding.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal, ModalCloseButton, ShowSearchDropdown, ToggleBar } from '@/components/show-cards';
import ShowImage from '@/components/ShowImage';
import StarRating from '@/components/user/StarRating';
import { useCurrentMarket } from '@/hooks/useCurrentMarket';
import { useWatchlist } from '@/hooks/useWatchlist';
import { getOptimizedImageUrl } from '@/lib/images';
import { removeLocalShow } from '@/lib/local-watchlist';
import { supabaseRestInsert, supabaseRestSelect } from '@/lib/supabase-rest';
import { trackUgc, type UgcProps } from '@/lib/ugc-analytics';
import {
  welcomeFinishDestination,
  welcomeMarketFor,
  welcomeSaveStep,
  welcomeWriteFor,
  type WelcomeMarket,
  type WelcomeShow,
} from '@/lib/welcome-onboarding';
import {
  QUIZ_STEP_COUNT,
  nextQuizStep,
  quizDoneMessage,
  quizLayoutFor,
  quizStepNumber,
  wantCandidates,
  type QuizLayout,
  type QuizStep,
} from '@/lib/web-signup-onboarding';

const MARKET_OPTIONS: { value: WelcomeMarket; label: string }[] = [
  { value: 'broadway', label: 'Broadway' },
  { value: 'west-end', label: 'West End' },
];

/**
 * Where a show already being in My Shows makes its poster unpickable. At save
 * time only reviews and seen_unrated skip a pick (welcomeSaveStep).
 */
const EXISTING_TABLES = ['reviews', 'watchlist', 'seen_unrated'] as const;

interface WelcomeSheetProps {
  /** null in preview mode (localhost ?welcome=preview): nothing is written or tracked. */
  userId: string | null;
  onClose: () => void;
}

export default function WelcomeSheet({ userId, onClose }: WelcomeSheetProps) {
  const router = useRouter();
  const preview = userId === null;
  // Add/remove only: cache, other open copies and analytics stay in step.
  const { addToWatchlist, removeFromWatchlist } = useWatchlist(userId);
  const [step, setStep] = useState<QuizStep>('shows');
  const [layout, setLayout] = useState<QuizLayout>(() => quizLayoutFor(typeof window === 'undefined' ? null : window.innerWidth));
  const pageMarket = useCurrentMarket();
  const [market, setMarket] = useState<WelcomeMarket>(() => welcomeMarketFor(pageMarket));
  const [lists, setLists] = useState<Partial<Record<WelcomeMarket, WelcomeShow[]>> | null>(null);
  // The Want grid's posters: shows still running or in previews.
  const [wantLists, setWantLists] = useState<Partial<Record<WelcomeMarket, WelcomeShow[]>>>({});
  const [wantSearched, setWantSearched] = useState<WelcomeShow[]>([]);
  const [wantPicks, setWantPicks] = useState<Set<string>>(new Set());
  const [wantAdded, setWantAdded] = useState(0);
  // Shows added through search: shown first in the grid, whatever the market.
  const [searched, setSearched] = useState<WelcomeShow[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [existing, setExisting] = useState<{ reviews: Set<string>; watchlist: Set<string>; seen: Set<string> }>({ reviews: new Set(), watchlist: new Set(), seen: new Set() });
  // showId -> stars (null = "seen it", no stars). Map keeps tap order.
  const [picks, setPicks] = useState<Map<string, number | null>>(new Map());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(0);
  // Seen picks actually written, so the Want grid leaves them out.
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  // A close-time save failed and they were told; a second close leaves without saving.
  const [closeAnyway, setCloseAnyway] = useState(false);
  const [showsAdded, setShowsAdded] = useState(0);
  // Of those, the ones saved without stars (they wait under To Be Rated).
  const [unratedAdded, setUnratedAdded] = useState(0);

  const track = useCallback((event: string, props: UgcProps = {}) => {
    if (!preview) trackUgc(event, props);
  }, [preview]);

  // Which list it opened on, so the welcome funnel can split Broadway from West End.
  const openedOn = useRef(market);
  useEffect(() => {
    track('onboarding_shown', { market: openedOn.current });
  }, [track]);

  useEffect(() => {
    const onResize = () => setLayout(quizLayoutFor(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/welcome-shows.json', { signal: controller.signal })
      .then(r => (r.ok ? r.json() : {}))
      .then((d: { shows?: WelcomeShow[]; markets?: Partial<Record<WelcomeMarket, WelcomeShow[]>>; want?: Partial<Record<WelcomeMarket, WelcomeShow[]>> }) => {
        // `markets` is per market; a build from before it existed has only Broadway's `shows`.
        const fromMarkets = d.markets && typeof d.markets === 'object' ? d.markets : {};
        setLists({ broadway: Array.isArray(d.shows) ? d.shows : [], ...fromMarkets });
        // No `want` (a build from before Part 4): the Want step offers search only.
        setWantLists(d.want && typeof d.want === 'object' ? d.want : {});
      })
      .catch(() => { if (!controller.signal.aborted) setLists({}); });
    return () => controller.abort();
  }, []);

  // Someone who signed up by rating a show already has it in the diary.
  useEffect(() => {
    if (!userId) return;
    const q = `select=show_id&user_id=eq.${encodeURIComponent(userId)}`;
    Promise.all(EXISTING_TABLES.map(t => supabaseRestSelect<{ show_id: string }>(t, q)))
      .then(([r, w, u]) => setExisting({
        reviews: new Set((r.data || []).map(x => x.show_id)),
        watchlist: new Set((w.data || []).map(x => x.show_id)),
        seen: new Set((u.data || []).map(x => x.show_id)),
      }))
      .catch(() => {});
  }, [userId]);

  // The page's market, unless that grid is empty (e.g. an older cached file
  // with Broadway only): then the first market that has posters.
  const shownMarket: WelcomeMarket = lists && !(lists[market] || []).length
    ? (MARKET_OPTIONS.find(o => (lists[o.value] || []).length > 0)?.value ?? market)
    : market;
  const shows = useMemo(() => {
    if (!lists) return null;
    const ids = new Set(searched.map(s => s.id));
    return [...searched, ...(lists[shownMarket] ?? []).filter(s => !ids.has(s.id))];
  }, [searched, lists, shownMarket]);
  // Every show a pick can point at, so a pick made under another market still has a title.
  const showById = useMemo(() => {
    const all = [...searched, ...Object.values(lists || {}).flat()];
    return new Map(all.map(s => [s.id, s]));
  }, [searched, lists]);
  const hasMarketChoice = !!lists && MARKET_OPTIONS.every(o => (lists[o.value] || []).length > 0);
  const activeShow = activeId ? showById.get(activeId) : undefined;
  const hasShow = (id: string) => existing.reviews.has(id) || existing.watchlist.has(id) || existing.seen.has(id);
  // Want grid: this market's bookable shows, minus anything seen (before or
  // just now) or already on the watchlist. Searched-in shows go first.
  const wantShows = useMemo(() => {
    const own = wantLists[shownMarket] ?? [];
    const ids = new Set(wantSearched.map(s => s.id));
    const all = [...wantSearched, ...own.filter(s => !ids.has(s.id))];
    return wantCandidates(all, {
      seen: [...Array.from(existing.reviews), ...Array.from(existing.seen), ...Array.from(savedIds)],
      watchlist: existing.watchlist,
    });
  }, [wantLists, wantSearched, shownMarket, existing, savedIds]);
  const wantBlocked = (id: string) => hasShow(id) || savedIds.has(id);

  /**
   * First tap picks a show and opens its star row. Tapping another picked
   * show moves the star row to it, so every pick can be rated; tapping the
   * one being rated again removes it (as does Remove in the star row).
   */
  const tapPoster = (id: string) => {
    if (!picks.has(id)) {
      setPicks(prev => new Map(prev).set(id, null));
      setActiveId(id);
    } else if (activeId !== id) {
      setActiveId(id);
    } else {
      removePick(id);
    }
  };

  const removePick = (id: string) => {
    setPicks(prev => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    if (activeId === id) setActiveId(null);
  };

  const addSearched = (found: { id: string; title: string; slug: string; images?: { thumbnail?: string } }) => {
    setSearchOpen(false);
    if (step === 'want') {
      if (wantBlocked(found.id)) return;
      if (!wantShows.some(s => s.id === found.id)) {
        setWantSearched(prev => [{ id: found.id, title: found.title, slug: found.slug, image: found.images?.thumbnail || '', closingDate: null }, ...prev]);
      }
      setWantPicks(prev => new Set(prev).add(found.id));
      track('onboarding_search_pick', { market, step: 'want' });
      return;
    }
    if (hasShow(found.id)) return;
    if (!showById.has(found.id)) {
      setSearched(prev => [{ id: found.id, title: found.title, slug: found.slug, image: found.images?.thumbnail || '', closingDate: null }, ...prev]);
    } else if (!(shows || []).some(s => s.id === found.id)) {
      setSearched(prev => [showById.get(found.id) as WelcomeShow, ...prev]);
    }
    setPicks(prev => (prev.has(found.id) ? prev : new Map(prev).set(found.id, null)));
    setActiveId(found.id);
    track('onboarding_search_pick', { market });
  };

  const setStars = (id: string, rating: number) => {
    setPicks(prev => new Map(prev).set(id, rating));
  };

  const toggleWant = (id: string) => {
    setWantPicks(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const go = (to: QuizStep | 'closed', addedNow = showsAdded, wantNow = wantAdded) => {
    if (to === 'closed') { onClose(); return; }
    setStep(to);
    setSearchOpen(false);
    setSaveError(null);
    setCloseAnyway(false);
    if (to === 'done') {
      track('onboarding_completed', {
        market,
        shows_added: addedNow,
        want_added: wantNow,
        destination: welcomeFinishDestination({ showsAdded: addedNow + wantNow, imported: 0 }),
      });
    }
  };

  /**
   * Saves the picks. thenClose: they closed the sheet with picks still
   * unsaved, so save them on the way out instead of dropping them.
   */
  const savePicks = async ({ thenClose = false } = {}) => {
    const entries = Array.from(picks.entries());
    const rated = entries.filter(([, r]) => r !== null).length;
    if (preview) {
      setShowsAdded(entries.length);
      setUnratedAdded(entries.filter(([showId, rating]) => welcomeWriteFor({ showId, rating }).table === 'seen_unrated').length);
      track('onboarding_step_completed', { step: 'shows', shows_added: entries.length, rated });
      if (thenClose) onClose();
      else go(nextQuizStep('shows', 'continue'), entries.length);
      return;
    }
    setSaving(true);
    setSaveError(null);
    // Look again right before writing: the first lookup may have failed, or a
    // show may have been added since (e.g. a bookmark saved at sign-in).
    // reviews allows several rows per show, so a second write would duplicate.
    const ids = entries.map(([id]) => id);
    const inList = `in.(${ids.map(id => `"${id}"`).join(',')})`;
    const q = `select=show_id&user_id=eq.${encodeURIComponent(userId as string)}&show_id=${encodeURIComponent(inList)}`;
    let seen: Set<string>;
    let watchlisted: Set<string>;
    try {
      const results = await Promise.all(EXISTING_TABLES.map(t => supabaseRestSelect<{ show_id: string }>(t, q)));
      if (results.some(x => x.error)) throw new Error('lookup failed');
      const idsIn = (t: (typeof EXISTING_TABLES)[number]) =>
        new Set((results[EXISTING_TABLES.indexOf(t)].data || []).map(x => x.show_id));
      watchlisted = idsIn('watchlist');
      seen = new Set([...Array.from(idsIn('reviews')), ...Array.from(idsIn('seen_unrated'))]);
    } catch {
      setSaving(false);
      failSave(thenClose);
      return;
    }
    let added = 0;
    let addedUnrated = 0;
    let failed = 0;
    // Bookmarks this save replaced. The hook can't count them: this sheet's
    // instance never loads the watchlist, so it can't tell a real row from none.
    let bookmarksCleared = 0;
    const saved = new Set<string>();
    for (const [showId, rating] of entries) {
      const { write, clearWatchlist } = welcomeSaveStep({ showId, rating }, { seen: seen.has(showId), watchlisted: watchlisted.has(showId) });
      if (!write) { saved.add(showId); removeLocalShow(showId); continue; }
      try {
        const { error } = await supabaseRestInsert(write.table, { user_id: userId, ...write.row });
        if (!error) {
          added++;
          if (write.table === 'seen_unrated') addedUnrated++;
          saved.add(showId);
        } else if (error.code === '23505') {
          // Already there (saved from another tab meanwhile): kept, not new.
          saved.add(showId);
        } else failed++;
      } catch {
        failed++;
      }
      if (!saved.has(showId)) continue;
      // Seen now: a copy saved while signed out must not move onto the watchlist later.
      removeLocalShow(showId);
      if (clearWatchlist) {
        try { await removeFromWatchlist(showId, 'rated'); bookmarksCleared++; } catch { /* pick saved; watchlist cleanup is best-effort */ }
      }
    }
    setSaving(false);
    setSavedIds(prev => new Set([...Array.from(prev), ...Array.from(saved)]));
    if (failed > 0 && (added === 0 || thenClose)) {
      // Some picks were written even though others failed: count them now,
      // because they may leave with the second close and send nothing more.
      if (added > 0) track('onboarding_step_completed', { step: 'shows', shows_added: added, rated, failed });
      // Only the saved ones are kept off the next try.
      setPicks(prev => new Map(Array.from(prev).filter(([id]) => !saved.has(id))));
      failSave(thenClose);
      return;
    }
    setShowsAdded(added);
    setUnratedAdded(addedUnrated);
    setSaveFailed(failed);
    track('onboarding_step_completed', { step: 'shows', shows_added: added, rated, failed, bookmarks_cleared: bookmarksCleared });
    if (thenClose) onClose();
    else go(nextQuizStep('shows', 'continue'), added);
  };

  /** Saves the Want picks as watchlist rows (same thenClose rule as Seen). */
  const saveWant = async ({ thenClose = false } = {}) => {
    const ids = Array.from(wantPicks);
    if (preview) {
      setWantAdded(ids.length);
      track('onboarding_step_completed', { step: 'want', want_added: ids.length });
      if (thenClose) onClose();
      else go(nextQuizStep('want', 'continue'), showsAdded, ids.length);
      return;
    }
    setSaving(true);
    setSaveError(null);
    let added = 0;
    let failed = 0;
    const saved = new Set<string>();
    for (const showId of ids) {
      try {
        await addToWatchlist(showId);
        added++;
        saved.add(showId);
      } catch {
        failed++;
      }
    }
    setSaving(false);
    if (failed > 0 && (added === 0 || thenClose)) {
      if (added > 0) track('onboarding_step_completed', { step: 'want', want_added: added, failed });
      setWantAdded(prev => prev + added);
      setWantPicks(prev => new Set(Array.from(prev).filter(id => !saved.has(id))));
      failSave(thenClose);
      return;
    }
    const total = wantAdded + added;
    setWantAdded(total);
    setSaveFailed(prev => prev + failed);
    track('onboarding_step_completed', { step: 'want', want_added: added, failed });
    if (thenClose) onClose();
    else go(nextQuizStep('want', 'continue'), showsAdded, total);
  };

  const failSave = (onClose: boolean) => {
    if (onClose) setCloseAnyway(true);
    setSaveError(onClose
      ? 'We could not save your picks. Try again, or close again to leave without them.'
      : 'We could not save those just now. Check your connection and try again.');
  };

  const skip = (via: 'skip' | 'close') => {
    if (saving) return;
    track('onboarding_skipped', { step, via });
    if (via === 'close' && !closeAnyway) {
      // Closed with picks still unsaved: save them on the way out.
      if (step === 'shows' && picks.size > 0) { void savePicks({ thenClose: true }); return; }
      if (step === 'want' && wantPicks.size > 0) { void saveWant({ thenClose: true }); return; }
    }
    go(nextQuizStep(step, via === 'close' ? 'close' : 'skip'));
  };

  const finish = (dest: 'my-shows' | 'stay') => {
    onClose();
    if (dest !== 'my-shows') return;
    // Already on My Shows: its lists were loaded before these writes.
    if (window.location.pathname.replace(/\/$/, '') === '/my-shows') window.location.reload();
    else router.push('/my-shows');
  };

  const destination = welcomeFinishDestination({ showsAdded: showsAdded + wantAdded, imported: 0 });
  const pickCount = picks.size;
  const wantCount = wantPicks.size;
  const gridCols = layout === 'side-panel' ? 'grid-cols-3' : 'grid-cols-3 sm:grid-cols-4';

  return (
    <>
      <Modal
        isOpen
        onClose={() => (step === 'done' ? onClose() : skip('close'))}
        layout={layout}
        closeOnBackdrop={false}
        ariaLabel="Welcome to Broadway Scorecard"
      >
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden" data-testid="welcome-sheet" data-step={step} data-layout={layout}>
          <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-brand mb-1">
                {step === 'done' ? 'All set' : 'Optional setup'} · Step {quizStepNumber(step)} of {QUIZ_STEP_COUNT}
              </p>
              <h2 className="text-xl font-bold text-white leading-tight">
                {step === 'shows' && 'Which shows have you seen?'}
                {step === 'want' && 'Which shows do you want to see?'}
                {step === 'done' && (showsAdded + wantAdded > 0 ? 'Your shows are in' : "You're all set")}
              </h2>
              {step === 'shows' && (
                <p className="text-sm text-gray-400 mt-1">Tap any you&apos;ve seen. Stars are optional. Skip if you like.</p>
              )}
              {step === 'want' && (
                <p className="text-sm text-gray-400 mt-1">Tap any you&apos;d like to see. We&apos;ll keep them in Want to See.</p>
              )}
            </div>
            <ModalCloseButton onClick={() => (step === 'done' ? onClose() : skip('close'))} />
          </div>

          {(step === 'shows' || step === 'want') && (
            <>
              <div className="flex-1 min-h-0 overflow-y-auto px-5 pt-1 pb-3">
                {step === 'want' && showsAdded > 0 && (
                  <p className="text-sm text-status-open mb-2">Added {showsAdded} {showsAdded === 1 ? 'show' : 'shows'} to Seen.</p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  {hasMarketChoice ? (
                    <ToggleBar
                      options={MARKET_OPTIONS}
                      value={shownMarket}
                      onChange={m => { setMarket(m); track('onboarding_market_switch', { market: m }); }}
                      ariaLabel="Which theater scene"
                      variant="pill"
                    />
                  ) : <span />}
                  {!searchOpen && (
                    <button
                      type="button"
                      onClick={() => setSearchOpen(true)}
                      className="btn-ghost text-sm inline-flex items-center gap-1.5 min-h-[44px] px-1"
                      data-testid="welcome-search-open"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                      </svg>
                      Don&apos;t see yours?
                    </button>
                  )}
                </div>
                {searchOpen && (
                  <div className="mb-3" data-testid="welcome-search">
                    <ShowSearchDropdown
                      placeholder="Search any show"
                      onSelect={addSearched}
                      onClose={() => setSearchOpen(false)}
                      includeDiary
                      isDisabled={found => (step === 'want' ? wantBlocked(found.id) : hasShow(found.id))}
                      renderAction={found => ((step === 'want' ? wantBlocked(found.id) || wantPicks.has(found.id) : hasShow(found.id) || picks.has(found.id))
                        ? <span className="text-status-open">Added</span>
                        : <span>+ Add</span>)}
                    />
                  </div>
                )}
                {step === 'want' ? (
                  wantShows.length === 0 ? (
                    <p className="text-sm text-gray-400 py-6 text-center">Use Don&apos;t see yours? to search for any show.</p>
                  ) : (
                    <ul className={`grid ${gridCols} gap-2`} data-testid="welcome-want-grid">
                      {wantShows.map(show => {
                        const picked = wantPicks.has(show.id);
                        return (
                          <li key={show.id}>
                            <button
                              type="button"
                              onClick={() => toggleWant(show.id)}
                              disabled={saving}
                              aria-pressed={picked}
                              aria-label={`${show.title}${picked ? ', want to see' : ''}`}
                              className={`relative block w-full aspect-[2/3] rounded-lg overflow-hidden bg-surface-raised border transition ${
                                picked ? 'border-brand ring-2 ring-brand' : 'border-white/10 hover:border-white/20'
                              }`}
                            >
                              <ShowImage
                                sizes="(min-width: 640px) 120px, 30vw"
                                sources={show.image ? [getOptimizedImageUrl(show.image, 'thumbnail')] : []}
                                alt=""
                                ariaHidden
                                loading="lazy"
                                className="absolute inset-0 w-full h-full object-cover"
                                fallback={<span className="absolute inset-0 flex items-center justify-center p-2 text-xs text-gray-300 text-center">{show.title}</span>}
                              />
                              {picked && <span className="absolute inset-0 bg-surface/50" aria-hidden="true" />}
                              {picked && (
                                <span className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-brand text-surface flex items-center justify-center" aria-hidden="true">
                                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 3h12a1 1 0 011 1v17l-7-4-7 4V4a1 1 0 011-1z" /></svg>
                                </span>
                              )}
                            </button>
                            <p className="mt-1 text-xs text-gray-400 truncate">{show.title}</p>
                          </li>
                        );
                      })}
                    </ul>
                  )
                ) : shows === null ? (
                  <div className={`grid ${gridCols} gap-2`} aria-hidden="true">
                    {Array.from({ length: 12 }, (_, i) => (
                      <div key={i} className="aspect-[2/3] rounded-lg bg-surface-raised animate-pulse" />
                    ))}
                  </div>
                ) : shows.length === 0 ? (
                  <p className="text-sm text-gray-400 py-6 text-center">Use Don&apos;t see yours? to search for any show.</p>
                ) : (
                  <ul className={`grid ${gridCols} gap-2`} data-testid="welcome-grid">
                    {shows.map(show => {
                      const already = hasShow(show.id);
                      const picked = picks.has(show.id);
                      const stars = picks.get(show.id);
                      return (
                        <li key={show.id}>
                          <button
                            type="button"
                            onClick={() => !already && tapPoster(show.id)}
                            disabled={already || saving}
                            aria-pressed={picked || already}
                            aria-label={already ? `${show.title}, already in My Shows` : `${show.title}${picked ? (activeId === show.id ? ', seen, rating now' : ', seen, tap to rate') : ''}`}
                            className={`relative block w-full aspect-[2/3] rounded-lg overflow-hidden bg-surface-raised border transition ${
                              picked ? `border-brand ring-2 ring-brand${activeId === show.id ? ' ring-offset-2 ring-offset-surface-elevated' : ''}` : 'border-white/10 hover:border-white/20'
                            } ${already ? 'cursor-default' : ''}`}
                          >
                            <ShowImage
                              sizes="(min-width: 640px) 120px, 30vw"
                              sources={show.image ? [getOptimizedImageUrl(show.image, 'thumbnail')] : []}
                              alt=""
                              ariaHidden
                              loading="lazy"
                              className="absolute inset-0 w-full h-full object-cover"
                              fallback={<span className="absolute inset-0 flex items-center justify-center p-2 text-xs text-gray-300 text-center">{show.title}</span>}
                            />
                            {(picked || already) && (
                              <span className="absolute inset-0 bg-surface/50" aria-hidden="true" />
                            )}
                            {(picked || already) && (
                              <span className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-brand text-surface flex items-center justify-center" aria-hidden="true">
                                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                              </span>
                            )}
                            {already && (
                              <span className="absolute bottom-0 inset-x-0 bg-surface/80 text-xs text-white py-1 text-center">In My Shows</span>
                            )}
                            {picked && typeof stars === 'number' && (
                              <span className="absolute bottom-0 inset-x-0 bg-surface/80 text-xs text-white py-1 text-center">★ {stars}</span>
                            )}
                          </button>
                          <p className="mt-1 text-xs text-gray-400 truncate">{show.title}</p>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div className="border-t border-white/10 px-5 py-3 bg-surface-elevated">
                {step === 'shows' && activeShow && picks.has(activeShow.id) && (
                  <div className="mb-3" data-testid="welcome-rate-row">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm text-gray-300 min-w-0 truncate">
                        Rate <span className="text-white font-medium">{activeShow.title}</span>?
                      </p>
                      <button type="button" onClick={() => removePick(activeShow.id)} disabled={saving} className="btn-ghost text-xs px-1 min-h-[44px] flex-shrink-0">
                        Remove
                      </button>
                    </div>
                    <StarRating
                      rating={picks.get(activeShow.id) ?? null}
                      onRatingChange={r => setStars(activeShow.id, r)}
                      size="sm"
                      hideLabel
                    />
                  </div>
                )}
                {saveError && <p className="text-sm text-score-skip mb-2">{saveError}</p>}
                {step === 'want' ? (
                  <div className="flex items-center justify-between gap-3">
                    {wantCount === 0 ? (
                      <>
                        <span className="text-sm text-gray-400">Nothing picked yet</span>
                        <button type="button" onClick={() => skip('skip')} className="btn-secondary text-sm">
                          Skip
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="text-sm text-gray-400">{wantCount} picked</span>
                        <button
                          type="button"
                          onClick={() => saveWant()}
                          disabled={saving}
                          className="btn-primary text-sm disabled:opacity-50"
                        >
                          {saving ? 'Saving…' : `Add ${wantCount} to Want to See`}
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                <div className="flex items-center justify-between gap-3">
                  {pickCount === 0 ? (
                    <>
                      <span className="text-sm text-gray-400">Nothing picked yet</span>
                      <button type="button" onClick={() => skip('skip')} className="btn-secondary text-sm">
                        Skip
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-sm text-gray-400">{pickCount} picked</span>
                      <button
                        type="button"
                        onClick={() => savePicks()}
                        disabled={saving}
                        className="btn-primary text-sm disabled:opacity-50"
                      >
                        {saving ? 'Saving…' : `Add ${pickCount} to Seen`}
                      </button>
                    </>
                  )}
                </div>
                )}
              </div>
            </>
          )}

          {step === 'done' && (
            <>
              <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-4 space-y-3">
                <p className="text-sm text-gray-300">{quizDoneMessage({ seenAdded: showsAdded, unratedAdded, wantAdded })}</p>
                {saveFailed > 0 && (
                  <p className="text-sm text-score-tepid">{saveFailed === 1 ? '1 show' : `${saveFailed} shows`} could not be saved. You can add {saveFailed === 1 ? 'it' : 'them'} later from My Shows.</p>
                )}
                <ul className="text-sm text-gray-400 space-y-1.5">
                  <li>Shows you’ve seen and want to see live in My Shows. Import from another app there any time.</li>
                </ul>
              </div>
              <div className="border-t border-white/10 px-5 py-3 bg-surface-elevated flex items-center justify-end gap-3">
                {destination === 'my-shows' ? (
                  <>
                    <button type="button" onClick={() => finish('stay')} className="btn-secondary text-sm">Keep browsing</button>
                    <button type="button" onClick={() => finish('my-shows')} className="btn-primary text-sm">See My Shows</button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => finish('my-shows')} className="btn-secondary text-sm">Open My Shows</button>
                    <button type="button" onClick={() => finish('stay')} className="btn-primary text-sm">Start exploring</button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
