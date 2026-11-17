'use client';

/**
 * One-time welcome for a brand-new account (BRO-4619, reshaped in BRO-6917
 * Part 4). Opened by WelcomeGate after claim_onboarding() succeeds. Two
 * skippable screens in a side panel (full screen on phones), mirroring the iOS
 * quiz:
 *   shows — tap the shows you've seen (stars optional), per market, or search
 *   want  — bookmark the shows you'd like to see (score on each poster)
 * Decisions live in src/lib/welcome-onboarding.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, ModalCloseButton, ScoreBadge, ShowSearchDropdown, ToggleBar } from '@/components/show-cards';
import ShowImage from '@/components/ShowImage';
import StarRating from '@/components/user/StarRating';
import { useToastSafe } from '@/components/ui/Toast';
import { useCurrentMarket } from '@/hooks/useCurrentMarket';
import { useWatchlist } from '@/hooks/useWatchlist';
import { getOptimizedImageUrl } from '@/lib/images';
import { removeLocalShow } from '@/lib/local-watchlist';
import { supabaseRestInsert, supabaseRestSelect } from '@/lib/supabase-rest';
import { trackUgc, type UgcProps } from '@/lib/ugc-analytics';
import {
  nextWelcomeStep,
  welcomeClosesLabel,
  welcomeMarketFor,
  welcomeSaveStep,
  welcomeSummary,
  welcomeWriteFor,
  type WelcomeMarket,
  type WelcomeShow,
  type WelcomeStep,
  type WelcomeWantShow,
} from '@/lib/welcome-onboarding';

const MARKET_OPTIONS: { value: WelcomeMarket; label: string }[] = [
  { value: 'broadway', label: 'Broadway' },
  { value: 'west-end', label: 'West End' },
];

const STEP_NUMBER: Record<WelcomeStep, number> = { shows: 1, want: 2 };

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
  const preview = userId === null;
  // Remove clears a bookmark a seen pick replaces; add saves the "want" picks.
  // Cache, other open copies and analytics stay in step through the hook.
  const { addToWatchlist, removeFromWatchlist } = useWatchlist(userId);
  const toast = useToastSafe();
  const [step, setStep] = useState<WelcomeStep>('shows');
  const pageMarket = useCurrentMarket();
  const [market, setMarket] = useState<WelcomeMarket>(() => welcomeMarketFor(pageMarket));
  const [lists, setLists] = useState<Partial<Record<WelcomeMarket, WelcomeShow[]>> | null>(null);
  const [wantLists, setWantLists] = useState<Partial<Record<WelcomeMarket, WelcomeWantShow[]>>>({});
  // Shows added through search: shown first in the grid, whatever the market.
  const [searched, setSearched] = useState<WelcomeShow[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [existing, setExisting] = useState<{ reviews: Set<string>; watchlist: Set<string>; seen: Set<string> }>({ reviews: new Set(), watchlist: new Set(), seen: new Set() });
  // showId -> stars (null = "seen it", no stars). Map keeps tap order.
  const [picks, setPicks] = useState<Map<string, number | null>>(new Map());
  const [activeId, setActiveId] = useState<string | null>(null);
  // Shows bookmarked on the second screen.
  const [wants, setWants] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Picks actually written, so the second screen does not offer them again.
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  // A close-time save failed and they were told; a second close leaves without saving.
  const [closeAnyway, setCloseAnyway] = useState(false);
  const [showsAdded, setShowsAdded] = useState(0);
  // Of those, the ones saved without stars (they wait under To Be Rated).
  const [unratedAdded, setUnratedAdded] = useState(0);
  // Bookmarks already written by an earlier try that partly failed.
  const [wantsAdded, setWantsAdded] = useState(0);
  // The state above lags one render behind a fast double tap; a ref does not.
  const savingRef = useRef(false);

  const track = useCallback((event: string, props: UgcProps = {}) => {
    if (!preview) trackUgc(event, props);
  }, [preview]);

  // Which list it opened on, so the welcome funnel can split Broadway from West End.
  const openedOn = useRef(market);
  useEffect(() => {
    track('onboarding_shown', { market: openedOn.current });
  }, [track]);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/welcome-shows.json', { signal: controller.signal })
      .then(r => (r.ok ? r.json() : {}))
      .then((d: {
        shows?: WelcomeShow[];
        markets?: Partial<Record<WelcomeMarket, WelcomeShow[]>>;
        wants?: Partial<Record<WelcomeMarket, WelcomeWantShow[]>>;
      }) => {
        // `markets` is per market; a build from before it existed has only Broadway's `shows`.
        const fromMarkets = d.markets && typeof d.markets === 'object' ? d.markets : {};
        setLists({ broadway: Array.isArray(d.shows) ? d.shows : [], ...fromMarkets });
        // `wants` is newer still: an older cached file simply has none.
        setWantLists(d.wants && typeof d.wants === 'object' ? d.wants : {});
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

  // Second screen: the market's best shows they have not already got somewhere.
  const wantMarket: WelcomeMarket = (wantLists[market] || []).length
    ? market
    : (MARKET_OPTIONS.find(o => (wantLists[o.value] || []).length > 0)?.value ?? market);
  const wantShows = useMemo(
    () => (wantLists[wantMarket] ?? []).filter(s => !existing.reviews.has(s.id) && !existing.seen.has(s.id)
      && !existing.watchlist.has(s.id) && !picks.has(s.id) && !savedIds.has(s.id)),
    [wantLists, wantMarket, existing, picks, savedIds],
  );

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
    setWants(prev => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  /** Leaves the sheet, with one line saying what was saved (nothing saved, no toast). */
  const leave = (counts: { seenAdded: number; wantAdded: number; unratedAdded: number }) => {
    const message = welcomeSummary(counts);
    onClose();
    if (message && !preview) toast.showToast(message, 'success');
  };

  const go = (to: WelcomeStep) => {
    setStep(to);
    setSaveError(null);
    setCloseAnyway(false);
  };

  /**
   * Saves the seen picks. thenClose: they closed the sheet with picks still
   * unsaved, so save them on the way out instead of dropping them.
   */
  const savePicks = async ({ thenClose = false } = {}) => {
    const entries = Array.from(picks.entries());
    const rated = entries.filter(([, r]) => r !== null).length;
    if (preview) {
      const unrated = entries.filter(([showId, rating]) => welcomeWriteFor({ showId, rating }).table === 'seen_unrated').length;
      setShowsAdded(entries.length);
      setUnratedAdded(unrated);
      track('onboarding_step_completed', { step: 'shows', shows_added: entries.length, rated });
      if (thenClose) leave({ seenAdded: entries.length, wantAdded: 0, unratedAdded: unrated });
      else go(nextWelcomeStep('shows'));
      return;
    }
    if (savingRef.current) return;
    savingRef.current = true;
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
      savingRef.current = false;
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
    savingRef.current = false;
    setSaving(false);
    setSavedIds(prev => new Set([...Array.from(prev), ...Array.from(saved)]));
    // Counts add up across tries, so a retry after a partial failure keeps the first run's saves.
    const totalAdded = showsAdded + added;
    const totalUnrated = unratedAdded + addedUnrated;
    if (failed > 0) {
      // Some picks may have been written even though others failed: count them now,
      // because they may leave with the second close and send nothing more.
      if (added > 0) track('onboarding_step_completed', { step: 'shows', shows_added: added, rated, failed });
      setShowsAdded(totalAdded);
      setUnratedAdded(totalUnrated);
      // Only the saved ones are kept off the next try; the sheet stays so they are told.
      setPicks(prev => new Map(Array.from(prev).filter(([id]) => !saved.has(id))));
      failSave(thenClose);
      return;
    }
    setShowsAdded(totalAdded);
    setUnratedAdded(totalUnrated);
    track('onboarding_step_completed', { step: 'shows', shows_added: added, rated, failed, bookmarks_cleared: bookmarksCleared });
    if (thenClose) leave({ seenAdded: totalAdded, wantAdded: 0, unratedAdded: totalUnrated });
    else go(nextWelcomeStep('shows'));
  };

  /** Saves the bookmarks from the second screen, then leaves. */
  const saveWants = async ({ thenClose = false } = {}) => {
    const ids = Array.from(wants);
    if (preview || ids.length === 0) {
      if (ids.length > 0) track('onboarding_step_completed', { step: 'want', want_added: ids.length });
      leave({ seenAdded: showsAdded, wantAdded: ids.length, unratedAdded });
      return;
    }
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    let added = 0;
    const done = new Set<string>();
    for (const id of ids) {
      try {
        await addToWatchlist(id);
        added++;
        done.add(id);
        removeLocalShow(id);
      } catch (e) {
        // A bookmark that is already there counts as saved, not as a failure.
        if (e instanceof Error && /duplicate|already exists|23505/i.test(e.message)) done.add(id);
      }
    }
    savingRef.current = false;
    setSaving(false);
    const failed = ids.length - done.size;
    const totalWants = wantsAdded + added;
    if (failed > 0) {
      if (added > 0) track('onboarding_step_completed', { step: 'want', want_added: added, failed });
      setWantsAdded(totalWants);
      // Only the ones that did not save stay picked; the sheet stays so they are told.
      setWants(prev => new Set(Array.from(prev).filter(id => !done.has(id))));
      failSave(thenClose);
      return;
    }
    track('onboarding_step_completed', { step: 'want', want_added: added, failed });
    track('onboarding_completed', { market, shows_added: showsAdded, want_added: totalWants });
    leave({ seenAdded: showsAdded, wantAdded: totalWants, unratedAdded });
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
    if (via === 'close') {
      if (step === 'shows' && picks.size > 0 && !closeAnyway) {
        void savePicks({ thenClose: true });
        return;
      }
      if (step === 'want' && wants.size > 0 && !closeAnyway) {
        void saveWants({ thenClose: true });
        return;
      }
      leave({ seenAdded: showsAdded, wantAdded: step === 'want' ? wantsAdded : 0, unratedAdded });
      return;
    }
    if (step === 'want') {
      // Reaching the end of the second screen with nothing to add still finishes the welcome.
      track('onboarding_completed', { market, shows_added: showsAdded, want_added: wantsAdded });
      leave({ seenAdded: showsAdded, wantAdded: wantsAdded, unratedAdded });
      return;
    }
    go(nextWelcomeStep(step));
  };

  const pickCount = picks.size;
  const wantCount = wants.size;

  const marketToggle = hasMarketChoice ? (
    <ToggleBar
      options={MARKET_OPTIONS}
      value={shownMarket}
      onChange={m => { setMarket(m); track('onboarding_market_switch', { market: m }); }}
      ariaLabel="Which theater scene"
      variant="pill"
    />
  ) : <span />;

  return (
    <Modal
      isOpen
      onClose={() => skip('close')}
      sidePanel
      closeOnBackdrop={false}
      ariaLabel="Welcome to Broadway Scorecard"
    >
      <div className="flex flex-col h-full min-h-0" data-testid="welcome-sheet" data-step={step}>
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 flex-shrink-0">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-brand mb-1">
              Welcome · Step {STEP_NUMBER[step]} of 2
            </p>
            <h2 className="text-xl font-bold text-white leading-tight">
              {step === 'shows' ? 'Which have you seen?' : 'Which do you want to see?'}
            </h2>
            <p className="text-sm text-gray-400 mt-1">
              {step === 'shows'
                ? 'Tap any you’ve seen. Stars are optional.'
                : 'Tap the ones you’d like to catch. We’ll keep them in your To See list.'}
            </p>
          </div>
          <ModalCloseButton onClick={() => skip('close')} className="p-3 -m-3" />
        </div>

        {step === 'shows' && (
          <>
            <div className="flex-1 min-h-0 overflow-y-auto px-5 pt-1 pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                {marketToggle}
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
                    isDisabled={found => hasShow(found.id)}
                    renderAction={found => (hasShow(found.id) || picks.has(found.id)
                      ? <span className="text-status-open">Added</span>
                      : <span>+ Add</span>)}
                  />
                </div>
              )}
              {shows === null ? (
                <div className="grid grid-cols-3 gap-2" aria-hidden="true">
                  {Array.from({ length: 12 }, (_, i) => (
                    <div key={i} className="aspect-[2/3] rounded-lg bg-surface-raised animate-pulse" />
                  ))}
                </div>
              ) : shows.length === 0 ? (
                <p className="text-sm text-gray-400 py-6 text-center">Use Don&apos;t see yours? to search for any show.</p>
              ) : (
                <ul className="grid grid-cols-3 gap-2" data-testid="welcome-grid">
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
                            sizes="(min-width: 640px) 140px, 30vw"
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
                            <span className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-cta text-white text-shadow-cta flex items-center justify-center" aria-hidden="true">
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

            <div className="border-t border-white/10 px-5 py-3 bg-surface-elevated flex-shrink-0">
              {activeShow && picks.has(activeShow.id) && (
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
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-gray-400">{pickCount === 0 ? 'Nothing picked yet' : `${pickCount} picked`}</span>
                {pickCount === 0 ? (
                  <button type="button" onClick={() => skip('skip')} className="btn-secondary text-sm" data-testid="welcome-next">
                    Skip
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => savePicks()}
                    disabled={saving}
                    className="btn-primary text-sm disabled:opacity-50"
                    data-testid="welcome-next"
                  >
                    {saving ? 'Saving…' : 'Next'}
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {step === 'want' && (
          <>
            <div className="flex-1 min-h-0 overflow-y-auto px-5 pt-1 pb-3">
              {hasMarketChoice && <div className="mb-3">{marketToggle}</div>}
              {lists === null ? (
                <div className="grid grid-cols-3 gap-2" aria-hidden="true">
                  {Array.from({ length: 9 }, (_, i) => (
                    <div key={i} className="aspect-[2/3] rounded-lg bg-surface-raised animate-pulse" />
                  ))}
                </div>
              ) : wantShows.length === 0 ? (
                <p className="text-sm text-gray-400 py-6 text-center">
                  Nothing to suggest right now. You can save shows to To See from any show page.
                </p>
              ) : (
                <ul className="grid grid-cols-3 gap-2" data-testid="welcome-want-grid">
                  {wantShows.map(show => {
                    const saved = wants.has(show.id);
                    const closes = welcomeClosesLabel(show.closingDate);
                    return (
                      <li key={show.id}>
                        <button
                          type="button"
                          onClick={() => toggleWant(show.id)}
                          disabled={saving}
                          aria-pressed={saved}
                          aria-label={`${show.title}, critic score ${show.score}${closes ? `, ${closes.toLowerCase()}` : ''}${saved ? ', saved to To See' : ', tap to save to To See'}`}
                          className={`relative block w-full aspect-[2/3] rounded-lg overflow-hidden bg-surface-raised border transition ${
                            saved ? 'border-brand ring-2 ring-brand' : 'border-white/10 hover:border-white/20'
                          }`}
                        >
                          <ShowImage
                            sizes="(min-width: 640px) 140px, 30vw"
                            sources={show.image ? [getOptimizedImageUrl(show.image, 'thumbnail')] : []}
                            alt=""
                            ariaHidden
                            loading="lazy"
                            className="absolute inset-0 w-full h-full object-cover"
                            fallback={<span className="absolute inset-0 flex items-center justify-center p-2 text-xs text-gray-300 text-center">{show.title}</span>}
                          />
                          {saved && <span className="absolute inset-0 bg-surface/40" aria-hidden="true" />}
                          <span className="absolute top-1.5 left-1.5" aria-hidden="true">
                            <ScoreBadge score={show.score} size="xs" />
                          </span>
                          <span
                            className={`absolute top-1.5 right-1.5 w-7 h-7 rounded-full flex items-center justify-center ${
                              saved ? 'bg-cta text-white text-shadow-cta' : 'bg-surface/80 text-white'
                            }`}
                            aria-hidden="true"
                          >
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill={saved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 4a2 2 0 012-2h10a2 2 0 012 2v18l-7-4-7 4V4z" />
                            </svg>
                          </span>
                        </button>
                        <p className="mt-1 text-xs text-gray-400 truncate">{show.title}</p>
                        {closes && <p className="text-xs text-score-tepid truncate">{closes}</p>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="border-t border-white/10 px-5 py-3 bg-surface-elevated flex-shrink-0">
              {saveError && <p className="text-sm text-score-skip mb-2">{saveError}</p>}
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-gray-400">{wantCount === 0 ? 'Nothing saved yet' : `${wantCount} saved`}</span>
                {wantCount === 0 ? (
                  <button type="button" onClick={() => skip('skip')} className="btn-secondary text-sm" data-testid="welcome-done">
                    Skip
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => saveWants()}
                    disabled={saving}
                    className="btn-primary text-sm disabled:opacity-50"
                    data-testid="welcome-done"
                  >
                    {saving ? 'Saving…' : 'Done'}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
