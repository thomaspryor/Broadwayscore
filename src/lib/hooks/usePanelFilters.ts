'use client';

import { useMemo, useCallback } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import type { ShowCardShow } from '@/components/show-cards/types';
import { type FilterPredicateCtx, TIME_PERIOD_RANGE } from '@/lib/show-filter-predicates';
import type { AwardWinnerSets } from '@/lib/data-awards';
import {
  type DateRange,
  parseDateRanges,
  serializeDateRanges,
  labelForRange,
  rangesEqual,
} from '@/lib/tony-seasons';
import {
  FILTER_GROUPS,
  PANEL_PARAM_KEYS,
  SINGLE_PARAM_KEYS,
  findFilterOption,
  findSingleOption,
  type FilterOption,
  type SingleGroupConfig,
} from '@/components/filters/filter-ui-config';
import type { ActiveFilterChip } from '@/components/filters/ActiveFilterChips';

interface UsePanelFiltersArgs<T extends ShowCardShow> {
  /** Pre-filtered shows from existing inline filters — panel applies on top */
  shows: T[];
  /** Pre-computed award winner ID arrays from server */
  awardWinnerSets?: AwardWinnerSets;
  /** Active score-mode — Score tier predicates filter against this score */
  scoreMode?: 'critics' | 'audience';
  /** Per-page single-select groups (Type, Status) — page provides Status options. */
  singleGroups?: SingleGroupConfig[];
  /**
   * Controlled-mode override for single-select values. The page is the source
   * of truth for `type`/`status` (inline ToggleBars use local state + write URL
   * via window.history.replaceState, which doesn't trigger useSearchParams).
   * When provided, the hook reads single values from this map instead of the URL.
   */
  singleValueOverrides?: Record<string, string>;
  /**
   * Controlled-mode write callback for single-select. When provided, the hook
   * delegates writes to the page's updateParams (which owns local filters state
   * + URL sync), keeping inline pills, the list, and panel chips/badge in sync.
   * Receives `defaultValue` when the user clears the chip — page should treat
   * that as a reset (e.g. updateParams({ [paramKey]: null })).
   */
  onSetSingleValueOverride?: (paramKey: string, value: string) => void;
}

interface UsePanelFiltersReturn<T extends ShowCardShow> {
  /** Final shows after panel predicates */
  filteredShows: T[];
  /** Number of selected panel filter options across all groups (multi + non-default single + each date range) */
  activeCount: number;
  /** Per-group selected sets (multi-select), keyed by paramKey */
  selectedByGroup: Record<string, ReadonlySet<string>>;
  /** Per-group current value (single-select), keyed by paramKey */
  singleValueByGroup: Record<string, string>;
  /** Active time-period date ranges (ISO YYYY-MM-DD). Empty = no filter. */
  dateRanges: DateRange[];
  /** Toggle a single option in a multi-select group */
  toggleOption: (paramKey: string, id: string) => void;
  /** Set the value of a single-select group (writes URL param; default value deletes it) */
  setSingleValue: (paramKey: string, value: string) => void;
  /**
   * Set the active date ranges. Accepts an array (replace) OR a function
   * that receives the LIVE URL state (read from window.location.search,
   * not React state). The function form is required for back-to-back
   * toggles in the same tick — see feedback_react_searchparams_stale.md.
   */
  setDateRanges: (ranges: DateRange[] | ((prev: DateRange[]) => DateRange[])) => void;
  /** Remove a single chip */
  removeChip: (chipKey: string) => void;
  /** Clear every panel filter */
  clearAll: () => void;
  /** Chips for ActiveFilterChips */
  chips: ActiveFilterChip[];
}

/**
 * Owns the advanced-filter-panel state. Reads from URL searchParams,
 * writes back via router.replace. Applies predicates as a final step
 * on the already-filtered show list (purely additive — does not touch
 * existing inline filter logic).
 *
 * Single-select groups (Type, Status) mirror the inline ToggleBars: the
 * panel reads/writes the same URL params so the inline pills stay in sync.
 * No predicates are applied for single-select — inline filtering already
 * narrows the `shows` array on those params upstream.
 */
export function usePanelFilters<T extends ShowCardShow>({
  shows,
  awardWinnerSets,
  scoreMode = 'critics',
  singleGroups,
  singleValueOverrides,
  onSetSingleValueOverride,
}: UsePanelFiltersArgs<T>): UsePanelFiltersReturn<T> {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Stable reference for the optional singleGroups prop — empty array if omitted
  const singleGroupsList = useMemo<SingleGroupConfig[]>(() => singleGroups ?? [], [singleGroups]);

  // Active date ranges from URL — single source of truth for Time period.
  // Format: ?dates=YYYY-MM-DD~YYYY-MM-DD,YYYY-MM-DD~YYYY-MM-DD
  const dateRanges = useMemo(
    () => parseDateRanges(searchParams?.get('dates') ?? null),
    [searchParams],
  );

  // Build predicate ctx from server-supplied award sets (rebuild Sets once)
  const ctx: FilterPredicateCtx = useMemo(() => {
    const ws = awardWinnerSets;
    return {
      tonyWinnerIds: new Set(ws?.tonyWinnerIds ?? []),
      tonyNomineeIds: new Set(ws?.tonyNomineeIds ?? []),
      olivierWinnerIds: new Set(ws?.olivierWinnerIds ?? []),
      olivierNomineeIds: new Set(ws?.olivierNomineeIds ?? []),
      dramaDeskWinnerIds: new Set(ws?.dramaDeskWinnerIds ?? []),
      pulitzerWinnerIds: new Set(ws?.pulitzerWinnerIds ?? []),
      dateRanges,
      scoreMode,
    };
  }, [awardWinnerSets, scoreMode, dateRanges]);

  // Parse selected ids per paramKey from URL (multi-select)
  const selectedByGroup = useMemo(() => {
    const out: Record<string, ReadonlySet<string>> = {};
    for (const group of FILTER_GROUPS) {
      const raw = searchParams?.get(group.paramKey);
      if (!raw) {
        out[group.paramKey] = new Set();
        continue;
      }
      const ids = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      out[group.paramKey] = new Set(ids);
    }
    return out;
  }, [searchParams]);

  // Parse current value per single-select group. Prefers controlled-mode
  // overrides from the page (its local filters state) so the panel mirrors the
  // inline ToggleBar without depending on useSearchParams (which doesn't fire
  // on window.history.replaceState that inline writes use).
  const singleValueByGroup = useMemo(() => {
    const out: Record<string, string> = {};
    for (const group of singleGroupsList) {
      const overridden = singleValueOverrides?.[group.paramKey];
      if (overridden !== undefined) {
        const known = group.options.some((o) => o.id === overridden);
        out[group.paramKey] = known ? overridden : group.defaultValue;
        continue;
      }
      const raw = searchParams?.get(group.paramKey);
      const known = raw && group.options.some((o) => o.id === raw);
      out[group.paramKey] = known ? raw : group.defaultValue;
    }
    return out;
  }, [searchParams, singleGroupsList, singleValueOverrides]);

  // Collect active predicates (multi-option = OR within group, AND across groups)
  const activePredicatesByGroup: { paramKey: string; predicates: FilterOption[] }[] = useMemo(() => {
    return FILTER_GROUPS.map((group) => {
      const selected = selectedByGroup[group.paramKey];
      const matched = group.options.filter((opt) => selected.has(opt.id));
      return { paramKey: group.paramKey, predicates: matched };
    }).filter((g) => g.predicates.length > 0);
  }, [selectedByGroup]);

  const filteredShows = useMemo(() => {
    const hasGroupFilters = activePredicatesByGroup.length > 0;
    const hasDateFilter = dateRanges.length > 0;
    if (!hasGroupFilters && !hasDateFilter) return shows;
    return shows.filter((show) => {
      if (hasDateFilter && !TIME_PERIOD_RANGE(show, ctx)) return false;
      for (const group of activePredicatesByGroup) {
        // Within a group: any-of (OR)
        const groupPasses = group.predicates.some((opt) => opt.predicate(show, ctx));
        if (!groupPasses) return false;
      }
      return true;
    });
  }, [shows, activePredicatesByGroup, ctx, dateRanges]);

  const activeCount = useMemo(() => {
    let count = Object.values(selectedByGroup).reduce((sum, s) => sum + s.size, 0);
    count += dateRanges.length;
    for (const group of singleGroupsList) {
      if (singleValueByGroup[group.paramKey] !== group.defaultValue) count += 1;
    }
    return count;
  }, [selectedByGroup, dateRanges, singleGroupsList, singleValueByGroup]);

  const chips: ActiveFilterChip[] = useMemo(() => {
    const out: ActiveFilterChip[] = [];
    // Multi-select chips
    for (const [paramKey, selected] of Object.entries(selectedByGroup)) {
      Array.from(selected).forEach((id) => {
        const option = findFilterOption(paramKey, id);
        if (option) {
          out.push({ key: `${paramKey}:${id}`, label: option.label });
        }
      });
    }
    // Single-select chips — only when current !== default
    for (const group of singleGroupsList) {
      const current = singleValueByGroup[group.paramKey];
      if (current !== group.defaultValue) {
        const opt = findSingleOption(group, current);
        if (opt) {
          out.push({
            key: `${group.paramKey}:${current}`,
            label: `${group.label}: ${opt.label}`,
          });
        }
      }
    }
    for (const range of dateRanges) {
      out.push({
        key: `dates:${range.from}~${range.to}`,
        label: labelForRange(range),
      });
    }
    return out;
  }, [selectedByGroup, dateRanges, singleGroupsList, singleValueByGroup]);

  const writeParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      // Read from live URL — searchParams is React state and may lag behind
      // rapid back-to-back updates, dropping params silently otherwise.
      const live = typeof window !== 'undefined' ? window.location.search : (searchParams?.toString() ?? '');
      const params = new URLSearchParams(live);
      mutate(params);
      const qs = params.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      // Two writes to the SAME URL:
      //   1. replaceState so subsequent in-tick reads of window.location see it
      //      (router.replace is async — lets back-to-back toggles overwrite each
      //      other; verified manually 2026-04-27 with 2-3 rapid season pills).
      //   2. router.replace so Next.js's useSearchParams() updates and React
      //      re-renders the panel.
      // Same URL on both → no two-writer race (see feedback_clearall_two_writer_race.md).
      if (typeof window !== 'undefined') {
        window.history.replaceState(null, '', url);
      }
      router.replace(url, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const toggleOption = useCallback(
    (paramKey: string, id: string) => {
      writeParams((params) => {
        const current = (params.get(paramKey) ?? '').split(',').filter(Boolean);
        const idx = current.indexOf(id);
        if (idx >= 0) current.splice(idx, 1);
        else current.push(id);
        if (current.length > 0) params.set(paramKey, current.join(','));
        else params.delete(paramKey);
      });
    },
    [writeParams],
  );

  const setSingleValue = useCallback(
    (paramKey: string, value: string) => {
      // Controlled mode: delegate to the page so its local filters state +
      // inline pills + the list re-filter all stay in sync with the panel.
      if (onSetSingleValueOverride) {
        onSetSingleValueOverride(paramKey, value);
        return;
      }
      const group = singleGroupsList.find((g) => g.paramKey === paramKey);
      writeParams((params) => {
        // Match the existing inline-filter convention: omit the param when it's the default
        if (group && value === group.defaultValue) params.delete(paramKey);
        else params.set(paramKey, value);
      });
    },
    [writeParams, singleGroupsList, onSetSingleValueOverride],
  );

  const setDateRanges = useCallback(
    (ranges: DateRange[] | ((prev: DateRange[]) => DateRange[])) => {
      writeParams((params) => {
        const livePrev = parseDateRanges(params.get('dates'));
        const next = typeof ranges === 'function' ? ranges(livePrev) : ranges;
        if (next.length > 0) params.set('dates', serializeDateRanges(next));
        else params.delete('dates');
      });
    },
    [writeParams],
  );

  const removeChip = useCallback(
    (chipKey: string) => {
      if (chipKey.startsWith('dates:')) {
        const rangeStr = chipKey.slice('dates:'.length);
        const [from, to] = rangeStr.split('~');
        if (!from || !to) return;
        // Use functional form — `dateRanges` from React state can be stale
        // when chips are removed in rapid succession.
        setDateRanges((prev) => prev.filter((r) => !rangesEqual(r, { from, to })));
        return;
      }
      const [paramKey, id] = chipKey.split(':');
      if (!paramKey || !id) return;
      // Single-select chip → reset to default
      if (SINGLE_PARAM_KEYS.has(paramKey)) {
        const group = singleGroupsList.find((g) => g.paramKey === paramKey);
        if (group) setSingleValue(paramKey, group.defaultValue);
        return;
      }
      // Multi-select chip → toggle off
      toggleOption(paramKey, id);
    },
    [toggleOption, setSingleValue, setDateRanges, singleGroupsList],
  );

  // Hook-internal clearAll for non-controlled mode (no override props). When
  // the page owns single-select state (controlled mode), wire the page's own
  // handler at the FilterPanel/ActiveFilterChips call sites instead of using
  // panel.clearAll — mixing writeParams (router.replace) with the page's
  // updateParams (window.history.replaceState in startTransition) produces a
  // URL race where the deferred page write overwrites the router state, or the
  // synchronous router state overwrites the page write. See trace in
  // memory/feedback_clearall_two_writer_race.md.
  const clearAll = useCallback(() => {
    writeParams((params) => {
      Array.from(PANEL_PARAM_KEYS).forEach((key) => params.delete(key));
    });
  }, [writeParams]);

  return {
    filteredShows,
    activeCount,
    selectedByGroup,
    singleValueByGroup,
    dateRanges,
    toggleOption,
    setSingleValue,
    setDateRanges,
    removeChip,
    clearAll,
    chips,
  };
}
