'use client';

import { useMemo, useCallback } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import type { ShowCardShow } from '@/components/show-cards/types';
import type { FilterPredicateCtx } from '@/lib/show-filter-predicates';
import type { AwardWinnerSets } from '@/lib/data-awards';
import { FILTER_GROUPS, PANEL_PARAM_KEYS, findFilterOption, type FilterOption } from '@/components/filters/filter-ui-config';
import type { ActiveFilterChip } from '@/components/filters/ActiveFilterChips';

interface UsePanelFiltersArgs<T extends ShowCardShow> {
  /** Pre-filtered shows from existing inline filters — panel applies on top */
  shows: T[];
  /** Pre-computed award winner ID arrays from server */
  awardWinnerSets?: AwardWinnerSets;
}

interface UsePanelFiltersReturn<T extends ShowCardShow> {
  /** Final shows after panel predicates */
  filteredShows: T[];
  /** Number of selected panel filter options across all groups */
  activeCount: number;
  /** Per-group selected sets, keyed by paramKey */
  selectedByGroup: Record<string, ReadonlySet<string>>;
  /** Toggle a single option in a group */
  toggleOption: (paramKey: string, id: string) => void;
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
 */
export function usePanelFilters<T extends ShowCardShow>({
  shows,
  awardWinnerSets,
}: UsePanelFiltersArgs<T>): UsePanelFiltersReturn<T> {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

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
      yearRange: null, // wired in Sprint 3
    };
  }, [awardWinnerSets]);

  // Parse selected ids per paramKey from URL
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

  // Collect active predicates (multi-option = OR within group, AND across groups)
  const activePredicatesByGroup: { paramKey: string; predicates: FilterOption[] }[] = useMemo(() => {
    return FILTER_GROUPS.map((group) => {
      const selected = selectedByGroup[group.paramKey];
      const matched = group.options.filter((opt) => selected.has(opt.id));
      return { paramKey: group.paramKey, predicates: matched };
    }).filter((g) => g.predicates.length > 0);
  }, [selectedByGroup]);

  const filteredShows = useMemo(() => {
    if (activePredicatesByGroup.length === 0) return shows;
    return shows.filter((show) => {
      for (const group of activePredicatesByGroup) {
        // Within a group: any-of (OR)
        const groupPasses = group.predicates.some((opt) => opt.predicate(show, ctx));
        if (!groupPasses) return false;
      }
      return true;
    });
  }, [shows, activePredicatesByGroup, ctx]);

  const activeCount = useMemo(
    () => Object.values(selectedByGroup).reduce((sum, s) => sum + s.size, 0),
    [selectedByGroup],
  );

  const chips: ActiveFilterChip[] = useMemo(() => {
    const out: ActiveFilterChip[] = [];
    for (const [paramKey, selected] of Object.entries(selectedByGroup)) {
      Array.from(selected).forEach((id) => {
        const option = findFilterOption(paramKey, id);
        if (option) {
          out.push({ key: `${paramKey}:${id}`, label: option.label });
        }
      });
    }
    return out;
  }, [selectedByGroup]);

  const writeParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams?.toString() ?? '');
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

  const removeChip = useCallback(
    (chipKey: string) => {
      const [paramKey, id] = chipKey.split(':');
      if (paramKey && id) toggleOption(paramKey, id);
    },
    [toggleOption],
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
    toggleOption,
    removeChip,
    clearAll,
    chips,
  };
}
