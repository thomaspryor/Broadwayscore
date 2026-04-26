'use client';

import { useMemo, useCallback } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import type { ShowCardShow } from '@/components/show-cards/types';
import { type FilterPredicateCtx, TIME_PERIOD_RANGE } from '@/lib/show-filter-predicates';
import type { AwardWinnerSets } from '@/lib/data-awards';
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

/** Parse "FROM-TO" into {from, to}; returns null if malformed. */
function parseYearRange(raw: string | null): { from: number; to: number } | null {
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-(\d{4})$/);
  if (!m) return null;
  const from = parseInt(m[1], 10);
  const to = parseInt(m[2], 10);
  if (isNaN(from) || isNaN(to) || from > to) return null;
  return { from, to };
}

interface UsePanelFiltersArgs<T extends ShowCardShow> {
  /** Pre-filtered shows from existing inline filters — panel applies on top */
  shows: T[];
  /** Pre-computed award winner ID arrays from server */
  awardWinnerSets?: AwardWinnerSets;
  /** Active score-mode — Score tier predicates filter against this score */
  scoreMode?: 'critics' | 'audience';
  /** Per-page single-select groups (Type, Status) — page provides Status options. */
  singleGroups?: SingleGroupConfig[];
}

interface UsePanelFiltersReturn<T extends ShowCardShow> {
  /** Final shows after panel predicates */
  filteredShows: T[];
  /** Number of selected panel filter options across all groups (multi + non-default single + year) */
  activeCount: number;
  /** Per-group selected sets (multi-select), keyed by paramKey */
  selectedByGroup: Record<string, ReadonlySet<string>>;
  /** Per-group current value (single-select), keyed by paramKey */
  singleValueByGroup: Record<string, string>;
  /** Year range tuple — null if no time-period filter */
  yearRange: { from: number; to: number } | null;
  /** Toggle a single option in a multi-select group */
  toggleOption: (paramKey: string, id: string) => void;
  /** Set the value of a single-select group (writes URL param; default value deletes it) */
  setSingleValue: (paramKey: string, value: string) => void;
  /** Set the year range (or null to clear) */
  setYearRange: (range: { from: number; to: number } | null) => void;
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
}: UsePanelFiltersArgs<T>): UsePanelFiltersReturn<T> {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Stable reference for the optional singleGroups prop — empty array if omitted
  const singleGroupsList = useMemo<SingleGroupConfig[]>(() => singleGroups ?? [], [singleGroups]);

  // Year range from URL — single source of truth for Time period
  const yearRange = useMemo(() => parseYearRange(searchParams?.get('years') ?? null), [searchParams]);

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
      yearRange,
      scoreMode,
    };
  }, [awardWinnerSets, scoreMode, yearRange]);

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

  // Parse current value per single-select group (defaults applied if unset/unknown)
  const singleValueByGroup = useMemo(() => {
    const out: Record<string, string> = {};
    for (const group of singleGroupsList) {
      const raw = searchParams?.get(group.paramKey);
      const known = raw && group.options.some((o) => o.id === raw);
      out[group.paramKey] = known ? raw : group.defaultValue;
    }
    return out;
  }, [searchParams, singleGroupsList]);

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
    const hasYearFilter = yearRange !== null;
    if (!hasGroupFilters && !hasYearFilter) return shows;
    return shows.filter((show) => {
      if (hasYearFilter && !TIME_PERIOD_RANGE(show, ctx)) return false;
      for (const group of activePredicatesByGroup) {
        // Within a group: any-of (OR)
        const groupPasses = group.predicates.some((opt) => opt.predicate(show, ctx));
        if (!groupPasses) return false;
      }
      return true;
    });
  }, [shows, activePredicatesByGroup, ctx, yearRange]);

  const activeCount = useMemo(() => {
    let count = Object.values(selectedByGroup).reduce((sum, s) => sum + s.size, 0);
    if (yearRange) count += 1;
    for (const group of singleGroupsList) {
      if (singleValueByGroup[group.paramKey] !== group.defaultValue) count += 1;
    }
    return count;
  }, [selectedByGroup, yearRange, singleGroupsList, singleValueByGroup]);

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
    if (yearRange) {
      const label = yearRange.from === yearRange.to
        ? `${yearRange.from}–${String((yearRange.from + 1) % 100).padStart(2, '0')}`
        : `${yearRange.from}–${yearRange.to}`;
      out.push({ key: 'years:_range', label });
    }
    return out;
  }, [selectedByGroup, yearRange, singleGroupsList, singleValueByGroup]);

  const writeParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      // Read from live URL — searchParams is React state and may lag behind
      // rapid back-to-back updates, dropping params silently otherwise.
      const live = typeof window !== 'undefined' ? window.location.search : (searchParams?.toString() ?? '');
      const params = new URLSearchParams(live);
      mutate(params);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
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
      const group = singleGroupsList.find((g) => g.paramKey === paramKey);
      writeParams((params) => {
        // Match the existing inline-filter convention: omit the param when it's the default
        if (group && value === group.defaultValue) params.delete(paramKey);
        else params.set(paramKey, value);
      });
    },
    [writeParams, singleGroupsList],
  );

  const setYearRange = useCallback(
    (range: { from: number; to: number } | null) => {
      writeParams((params) => {
        if (range) params.set('years', `${range.from}-${range.to}`);
        else params.delete('years');
      });
    },
    [writeParams],
  );

  const removeChip = useCallback(
    (chipKey: string) => {
      if (chipKey === 'years:_range') {
        setYearRange(null);
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
    [toggleOption, setSingleValue, setYearRange, singleGroupsList],
  );

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
    yearRange,
    toggleOption,
    setSingleValue,
    setYearRange,
    removeChip,
    clearAll,
    chips,
  };
}
