// The Production Mix card's columns for the held /biz pages (owner, 2026-10-21:
// bring the Season Report's visuals to /biz). The Season Report builds the
// same columns inline; the shape matches MixCard's MixColumn. Pure.

import { MIX_ROW_LABELS, MIX_ROW_LABELS_HIDDEN, mix, seasonBaseline, type ComparisonRow, type MixBreakdown, type SeasonComparison, type SeasonProfile } from './season-profile';

function shortSeason(season: string): string {
  return `${season.slice(0, 4)}-${season.slice(7)}`;
}

/** One Production Mix column (structurally MixCard's MixColumn). */
export interface MixSectionColumn {
  label: string;
  note: string;
  mix: MixBreakdown;
  /** Seasons pooled in `mix` (1 for a single season). */
  seasons: number;
  value: 'current' | 'last' | 'avg';
}

/** The Production Mix card's columns (the season, last season, the pooled baseline) and its share rows. */
export function mixSection(profiles: SeasonProfile[], season: string, comparison: SeasonComparison | null): {
  columns: MixSectionColumn[];
  overallRows: ComparisonRow[];
  withinRows: ComparisonRow[];
} {
  const cur = profiles.find((p) => p.season === season) ?? null;
  const { baseline, last } = seasonBaseline(profiles, season);
  const inProgress = !!comparison?.inProgress;
  const columns: MixSectionColumn[] = [];
  if (cur) columns.push({ label: `${shortSeason(cur.season)}${inProgress ? ' so far' : ''}`, note: `${cur.productions} productions${inProgress ? ', opened or announced' : ''}`, mix: mix(cur), seasons: 1, value: 'current' });
  if (last) columns.push({ label: shortSeason(last.season), note: `${last.productions} productions`, mix: mix(last), seasons: 1, value: 'last' });
  if (baseline.length) columns.push({ label: 'Prior seasons avg', note: `${baseline.length} seasons pooled`, mix: mix(...baseline), seasons: baseline.length, value: 'avg' });
  const pick = (labels: readonly string[]) => labels.map((l) => comparison?.rows.find((r) => r.label === l)).filter((r): r is ComparisonRow => !!r);
  return { columns, overallRows: pick(MIX_ROW_LABELS.slice(0, 2)), withinRows: pick(MIX_ROW_LABELS.slice(2)) };
}

const MIX_ROWS = new Set<string>(MIX_ROW_LABELS_HIDDEN);

/** A comparison without the mix rows, for pages that show them in the Production Mix card instead. */
export function withoutMixRows(comparison: SeasonComparison): SeasonComparison {
  return { ...comparison, rows: comparison.rows.filter((r) => !MIX_ROWS.has(r.label)) };
}
