/**
 * canonProgress — Best Musical / Best Play checklists and "Saw it before it
 * won" (spec §5.2).
 *
 * "Saw it before it won" is a strict `date_seen < ceremonyDate` comparison on
 * plain date strings: seeing a show ON ceremony day is not seeing it first.
 *
 * CEREMONY DATE RESOLUTION: the winner rows in stats-canon.json carry both a
 * `ceremony` number and a `season` label, and the numbers are off by one for
 * ceremonies ≥75 (A Strange Loop — the 75th Tonys, June 2022 — is tagged 76;
 * an upstream generator artifact of the missing 2020-21 COVID season). The
 * season labels are correct, so we join through seasonWindows() by label and
 * fall back to the ceremony number only when the label doesn't resolve. Get
 * this wrong and every post-2021 winner gets a ceremony date a year late,
 * which silently inflates "Saw it before it won".
 */

import type { CanonWinner, DiaryRow, StatsCanon } from './types';
import { seasonWindows, windowForSeason } from './season-windows';
import type { SeasonWindow } from './season-windows';

export interface CanonEntry extends CanonWinner {
  seen: boolean;
  /** Earliest date_seen for this show, if any. */
  dateSeen: string | null;
  /** The ceremony date this winner was measured against. */
  ceremonyDate: string | null;
  /** date_seen strictly before the ceremony. */
  sawBeforeItWon: boolean;
}

export interface CanonList {
  total: number;
  seen: number;
  /** seen / total, 0–1. */
  completion: number;
  sawBeforeItWon: number;
  /** Every winner, newest ceremony first. */
  entries: CanonEntry[];
  unseen: CanonEntry[];
}

export interface CanonProgress {
  bestMusical: CanonList;
  bestPlay: CanonList;
  /** Across both lists. */
  totalSeen: number;
  totalSawBeforeItWon: number;
}

export interface CanonProgressOptions {
  /** Prebuilt windows; recomputed from `canon.ceremonies` when omitted. */
  windows?: SeasonWindow[];
}

function earliestSeen(rows: DiaryRow[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const row of rows) {
    if (!out.has(row.show_id)) {
      out.set(row.show_id, row.date_seen ?? null);
      continue;
    }
    const current = out.get(row.show_id) ?? null;
    if (row.date_seen && (current === null || row.date_seen < current)) {
      out.set(row.show_id, row.date_seen);
    }
  }
  return out;
}

function buildList(
  winners: CanonWinner[],
  seenMap: Map<string, string | null>,
  windows: SeasonWindow[],
  ceremonyDates: Map<number, string>
): CanonList {
  const entries: CanonEntry[] = (winners ?? []).map((w) => {
    const bySeason = windowForSeason(windows, w.season);
    const ceremonyDate = bySeason?.end ?? ceremonyDates.get(w.ceremony) ?? null;
    const seen = seenMap.has(w.id);
    const dateSeen = seen ? seenMap.get(w.id) ?? null : null;
    return {
      ...w,
      seen,
      dateSeen,
      ceremonyDate,
      sawBeforeItWon: !!(dateSeen && ceremonyDate && dateSeen < ceremonyDate),
    };
  });

  entries.sort((a, b) => b.ceremony - a.ceremony);

  const seen = entries.filter((e) => e.seen);
  return {
    total: entries.length,
    seen: seen.length,
    completion: entries.length ? seen.length / entries.length : 0,
    sawBeforeItWon: entries.filter((e) => e.sawBeforeItWon).length,
    entries,
    unseen: entries.filter((e) => !e.seen),
  };
}

export function canonProgress(
  rows: DiaryRow[],
  canon: StatsCanon,
  opts: CanonProgressOptions = {}
): CanonProgress {
  const windows = opts.windows ?? seasonWindows(canon);
  const ceremonyDates = new Map<number, string>();
  for (const c of canon?.ceremonies ?? []) {
    if (c && typeof c.date === 'string') ceremonyDates.set(c.ceremony, c.date);
  }

  const seenMap = earliestSeen(rows);
  const bestMusical = buildList(canon?.bestMusical ?? [], seenMap, windows, ceremonyDates);
  const bestPlay = buildList(canon?.bestPlay ?? [], seenMap, windows, ceremonyDates);

  return {
    bestMusical,
    bestPlay,
    totalSeen: bestMusical.seen + bestPlay.seen,
    totalSawBeforeItWon: bestMusical.sawBeforeItWon + bestPlay.sawBeforeItWon,
  };
}
