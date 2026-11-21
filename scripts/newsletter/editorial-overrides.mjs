// Owner-approved, one-week editorial exceptions for the weekly newsletter
// (BRO-7547). The fresh-run gate (fresh-run-reviews.mjs, BRO-3822) holds back
// a returning production until a T1/T2 outlet has reviewed THIS run. When the
// owner decides to feature such a show anyway, the decision is recorded as a
// row in editorial-overrides.json instead of relaxing the gate. A row is
// scoped to one weekStart and one edition, so it cannot leak into later weeks.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'editorial-overrides.json');

export function loadOverrides(file = DEFAULT_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed.overrides) ? parsed.overrides : [];
  } catch {
    return [];
  }
}

/** Rows that apply to this issue (same weekStart AND same edition). */
export function activeOverrides(all, { weekStart, edition }) {
  return (all || []).filter(o => o && o.showId && o.weekStart === weekStart && o.edition === edition);
}

export function waivesFreshRunGate(active, showId) {
  return (active || []).some(o => o.showId === showId && o.waiveFreshRunGate === true);
}

export function displayTitleFor(active, showId, fallback) {
  const o = (active || []).find(x => x.showId === showId && x.displayTitle);
  return o ? o.displayTitle : fallback;
}

/**
 * The editorial sentence for a waived show that moved venues, built only from
 * data we hold: the show's declared priorRuns venue and its current venue.
 * Returns null when the show has no prior run at a different venue (nothing
 * true to say), so a bad row can never invent a move.
 *
 * @param {{title:string, venue:string, priorRuns?:Array<{venue?:string}>}} show
 * @param {{avg:number,count:number}|null} agg
 * @param {string} name display name (no venue suffix)
 * @param {{fresh:(number|null), total:number}} [reviews] how many of the reviews
 *   are dated within the current run's window (see freshCutoffFor)
 */
export function movedNote(show, agg, name, reviews = {}) {
  const from = (show.priorRuns || []).map(r => r && r.venue).find(v => v && v !== show.venue);
  if (!from || !show.venue) return null;
  // Owner (2026-11-15): the cards show the theatre and the review count, so the
  // note says only that the show transferred and what that does to its score.
  if (!(agg && Number.isFinite(agg.avg) && agg.count)) return `${name} has transferred.`;
  const n = Math.round(agg.avg);
  const mostlyOld = Number.isFinite(reviews.fresh) && reviews.total > 0 && reviews.fresh * 2 < reviews.total;
  const mixed = Number.isFinite(reviews.fresh) && reviews.fresh > 0 && reviews.fresh < reviews.total;
  if (mostlyOld) return `${name} has transferred, so its ${n}/100 mostly reflects reviews of the earlier run and may move as new notices arrive.`;
  if (mixed) return `${name} has transferred, and its ${n}/100 draws on reviews of both runs.`;
  return `${name} has transferred, and sits at ${n}/100.`;
}
