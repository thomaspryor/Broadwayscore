// Pure display-decision logic for the show-page Commercial Scorecard
// (BizBuzzCard). Extracted per the test-extraction pattern so the Q1
// conflict rule and quality floor are locked by unit tests
// (tests/unit/commercial-display.test.mjs).
//
// Q1 owner sign-off (2026-07-13, plan card 39c637c5-416f-8132):
// producer announcements are ground truth. On any announced/curated
// recouped:true show the recoupment model is never quoted — no
// "model says X, producers say Y" dual display. Model estimates render
// ONLY when there is no announced/curated recoupment state.
//
// Quality floor (plan v2 Issue 7): modelDataQuality:'low' and
// modelMethod:'ai-estimated' numbers stay off the card entirely. The gate
// lives here (rendered inside the client component), NOT in the server
// component — isDemo() is false during SSR, so a server-side gate would
// silently hide the feature everywhere.

import type { ShowCommercial } from './data-types';

export type RecoupmentDisplayMode = 'announced' | 'model' | 'none';

/** Minimal shape the display-mode/quality-floor predicates actually read — lets
 *  callers with a narrower row type (e.g. the /biz all-shows table) reuse the
 *  same rules without reshaping into a full ShowCommercial. `modelMethod`
 *  allows null in addition to ShowCommercial's optional-only typing since
 *  several row shapes normalize "no method" to null rather than omitting it. */
interface RecoupmentSignals {
  modelDataQuality?: ShowCommercial['modelDataQuality'];
  modelMethod?: ShowCommercial['modelMethod'] | null;
  recouped: ShowCommercial['recouped'];
  modelRecoupmentPct?: ShowCommercial['modelRecoupmentPct'];
}

/** True when the recoupment model's output is trustworthy enough to render. */
export function meetsModelQualityFloor(commercial: Pick<RecoupmentSignals, 'modelDataQuality' | 'modelMethod'>): boolean {
  return (
    commercial.modelDataQuality !== 'low' &&
    commercial.modelMethod !== 'ai-estimated'
  );
}

/**
 * Which recoupment treatment the card renders:
 *  - 'announced': recouped:true — render the announcement, never the model.
 *    (Sprint 2 guarantees every recouped:true entry is cited or carries
 *    humanReviewedDesignation:true, but the rule keys off recouped alone so
 *    an uncited entry can never fall through to a dual display.)
 *  - 'model': model output exists and clears the quality floor.
 *  - 'none': nothing trustworthy to show. The legacy AI research estimate
 *    (estimatedRecoupmentPct) is deliberately NOT a fallback — it is
 *    ai-estimated by construction, exactly what the floor excludes.
 */
export function getRecoupmentDisplayMode(
  commercial: RecoupmentSignals
): RecoupmentDisplayMode {
  if (commercial.recouped === true) return 'announced';
  if (commercial.modelRecoupmentPct && meetsModelQualityFloor(commercial)) {
    return 'model';
  }
  return 'none';
}

/**
 * Editorial keeps (Q3 owner review) are recouped:true entries that survived
 * owner review WITHOUT a clean producer announcement — flagged
 * humanReviewedDesignation:true (Sweeney Todd, Appropriate, Into the Woods).
 * The card labels these "Scorecard editorial assessment" instead of claiming
 * producers announced. Keyed off the flag alone — recoupedSource is prose and
 * must never be parsed for meaning; if a future announced show also carries
 * the flag, the label under-claims (safe direction) rather than fabricating
 * an announcement.
 */
export function isEditorialRecoupment(commercial: ShowCommercial): boolean {
  return (
    commercial.recouped === true &&
    commercial.humanReviewedDesignation === true
  );
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "2025-01" → "January 2025"; "1999" → "1999"; junk → null. */
export function formatRecoupedDate(date: string | null | undefined): string | null {
  if (!date) return null;
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(date.trim());
  if (!m) return null;
  const [, year, month] = m;
  if (!month) return year;
  const idx = parseInt(month, 10) - 1;
  if (idx < 0 || idx > 11) return year;
  return `${MONTHS[idx]} ${year}`;
}
