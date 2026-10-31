// Pure display-decision logic for the show-page Profitability Scorecard
// (BizBuzzCard) and the /biz tables. Extracted per the test-extraction
// pattern so the rules are locked by unit tests
// (tests/unit/commercial-display.test.mjs, tests/unit/recoupment-progress-label.test.mjs,
// tests/unit/commercial-public-source.test.mjs).
//
// Q1 owner sign-off (2026-07-13, plan card 39c637c5-416f-8132):
// a recouped:true record is ground truth. On those shows the recoupment
// model is never quoted (no "model says X, record says Y" dual display).
// Model estimates render ONLY when there is no recouped state, and never on
// a closed show whose designation is final (BRO-4623).
//
// Quality floor (plan v2 Issue 7): modelDataQuality:'low' and
// modelMethod:'ai-estimated' numbers stay off the card entirely. The gate
// lives here (rendered inside the client component), NOT in the server
// component — isDemo() is false during SSR, so a server-side gate would
// silently hide the feature everywhere.

import type { ShowCommercial } from './data-types';
import { ourRecoupRangePct } from '../../scripts/lib/our-recoup-estimate';
import { getDesignationBadgeStyle, UNDISCLOSED_DESIGNATION, RECOUPED_UNDISCLOSED_DESIGNATION, TBD_STATUS_DESCRIPTIONS } from '@/config/commercial';
import { reportedReturnLabel } from '../../scripts/lib/reported-return';
import { returnSnapshotDate } from '../../scripts/lib/commercial-return-snapshot';
import {
  modelDisplayGuard, displayBasis, playedWeeks, independentEstimate, isRunning,
  analystRange, estimateFitsDesignation, RUNNING_SHOWN_MAX,
} from '../../scripts/lib/model-display-guard';
import { hasNoInvestorsToRepay, isLossDesignation, likelyOutcomeDesignation, ownReturnedEstimatePct, RECOUPED_DESIGNATIONS } from '../../scripts/lib/commercial-designations';
import { publicSourceText, isEstimatedCapitalization, isMaximumCapitalization, saysRecoupmentUnannounced } from '../../scripts/lib/public-source-text';
import { conversionOf } from '../../scripts/lib/commercial-conversion';
import { recoupReportedAfterClosing } from '../../scripts/lib/recoup-reported-after-closing';

export type RecoupmentDisplayMode = 'announced' | 'analyst' | 'model' | 'none';

/** Minimal shape the display-mode/quality-floor predicates actually read — lets
 *  callers with a narrower row type (e.g. the /biz all-shows table) reuse the
 *  same rules without reshaping into a full ShowCommercial. `modelMethod`
 *  allows null in addition to ShowCommercial's optional-only typing since
 *  several row shapes normalize "no method" to null rather than omitting it.
 *  `designation` and `status` (the show's shows.json status) are optional so
 *  older callers keep working; pass them wherever the show may be closed. */
interface RecoupmentSignals {
  modelDataQuality?: ShowCommercial['modelDataQuality'];
  modelMethod?: ShowCommercial['modelMethod'] | null;
  recouped: ShowCommercial['recouped'];
  modelRecoupmentPct?: ShowCommercial['modelRecoupmentPct'];
  /** Why the display guard held the model, and the held figure (applyModelDisplayGuard). */
  modelDisplayHold?: ShowCommercial['modelDisplayHold'];
  modelHeldRange?: ShowCommercial['modelHeldRange'];
  /** u/Boring_Waltz_9545's published estimate (BRO-5502). */
  analystRecoupPct?: ShowCommercial['analystRecoupPct'];
  /** Our own rounded range, used when there is no analyst figure (BRO-6245). */
  ourEstimateRangePct?: ShowCommercial['ourEstimateRangePct'];
  ourRecoupEstimatePct?: ShowCommercial['ourRecoupEstimatePct'];
  ourRecoupEstimateAsOf?: ShowCommercial['ourRecoupEstimateAsOf'];
  /** 'enhancement': a nonprofit production with commercial money to recoup (hasNoInvestorsToRepay). */
  productionType?: ShowCommercial['productionType'] | null;
  designation?: ShowCommercial['designation'];
  status?: string | null;
}

/** True when the recoupment model's output is trustworthy enough to render. */
export function meetsModelQualityFloor(commercial: Pick<RecoupmentSignals, 'modelDataQuality' | 'modelMethod'>): boolean {
  return (
    commercial.modelDataQuality !== 'low' &&
    commercial.modelMethod !== 'ai-estimated'
  );
}

/**
 * A closed show whose designation is final (anything but TBD) has a settled
 * outcome. "Nonprofit" on an enhancement deal names funding, not an outcome:
 * its estimates follow estimateFitsDesignation like a TBD's (BRO-5502). Its card and table row show the designation and cited facts only:
 * no model recoupment %, range, return or model confidence. (Lucky Guy read
 * "Flop" next to a model "~2.0x return"; Back to the Future "Flop" next to 86%.)
 */
export function isFinalClosedOutcome(signals: Pick<RecoupmentSignals, 'designation' | 'status'>): boolean {
  return signals.status === 'closed' && !!signals.designation && signals.designation !== 'TBD';
}

/**
 * The /biz loss cell (wording: lossOutcomePhrase). recouped:false alone is not evidence: the
 * stub enroller writes it on every new record, and nonprofit productions have
 * no investors to repay. Only a closed loss label (Fizzle, Flop, Did Not
 * Recoup: each defined as "closed without recouping") makes the claim.
 */
export function isClosedWithoutRecouping(
  signals: Pick<RecoupmentSignals, 'designation' | 'status' | 'recouped'>
): boolean {
  return (
    signals.status === 'closed' &&
    signals.recouped === false &&
    isLossDesignation(signals.designation)
  );
}

/**
 * Which recoupment treatment the card renders:
 *  - 'announced': recouped:true — render the recoupment record, never an estimate.
 *    (Sprint 2 guarantees every recouped:true entry is cited or carries
 *    humanReviewedDesignation:true, but the rule keys off recouped alone so
 *    an uncited entry can never fall through to a dual display.)
 *  - 'none' for a Nonprofit production (no investors to repay, BRO-4721) or a
 *    Tour Stop (its investors are repaid across the tour).
 *  - 'analyst': u/Boring_Waltz_9545's published estimate (BRO-5502). It leads
 *    wherever there is one (the analyst covers musicals).
 *  - 'model': model output exists and clears the quality floor (the guarded
 *    copy has already held solo shows, wide ranges and short runs).
 *    A closed TBD ("Undisclosed") shows either estimate as its final figure,
 *    labelled; owner 2026-10-16, replacing BRO-5020's blanket hide. A closed
 *    Fizzle or Flop shows one only when it agrees with the label
 *    (estimateFitsDesignation: Back to the Future "Flop" beside a model 86%
 *    stays hidden); any other final designation shows none.
 *  - 'none': nothing trustworthy to show. The legacy AI research estimate
 *    (estimatedRecoupmentPct) is deliberately NOT a fallback — it is
 *    ai-estimated by construction, exactly what the floor excludes.
 * displaysAnalyst / displaysModel (scripts/lib/model-display-guard.js) mirror this.
 */
export function getRecoupmentDisplayMode(
  commercial: RecoupmentSignals
): RecoupmentDisplayMode {
  if (commercial.recouped === true) return 'announced';
  if (hasNoInvestorsToRepay(commercial)) return 'none';
  if (getDisplayableAnalystRange(commercial)) return 'analyst';
  const model = commercial.modelRecoupmentPct;
  if (!model || !meetsModelQualityFloor(commercial)) return 'none';
  if (isFinalClosedOutcome(commercial) && !estimateFitsDesignation(model, commercial.designation)) return 'none';
  return 'model';
}

/** Display-guard holds that still let the model's central figure bound the analyst + model range. */
const RANGE_MODEL_HOLDS = new Set(['too-uncertain', 'estimates-disagree']);

/**
 * The model [low, central, high] that may bound the estimate range, or null.
 * A held model joins only when held for being too uncertain, for disagreeing
 * with an outside estimate, or for sitting far below costs, and never at a
 * central of 100+: that would hint at an unannounced recoupment (BRO-5073).
 */
function rangeModel(commercial: RecoupmentSignals): [number, number, number] | null {
  if (commercial.modelRecoupmentPct) return commercial.modelRecoupmentPct;
  const held = commercial.modelHeldRange;
  if (!held || !commercial.modelDisplayHold || held[1] >= 100) return null;
  if (RANGE_MODEL_HOLDS.has(commercial.modelDisplayHold)) return held;
  // Far below costs: the bar hides the number, not the fact (out-of-bounds, central < 0).
  // (<= 0: a page carries it floored at 0, publicHeldRange.)
  if (commercial.modelDisplayHold === 'out-of-bounds' && held[1] <= 0) return held;
  return null;
}

/**
 * What a page may carry of the held model: its central figure alone, floored
 * at 0, and only when rangeModel would use it. The held range itself stays
 * server-only (a negative or unannounced-recoupment figure never reaches a page).
 */
export function publicHeldRange(commercial: RecoupmentSignals): [number, number, number] | null {
  if (commercial.modelRecoupmentPct || commercial.recouped === true || hasNoInvestorsToRepay(commercial)) return null;
  const model = rangeModel(commercial);
  if (!model) return null;
  const central = Math.max(0, model[1]);
  return [central, central, central];
}

/** Nearest 5: a recoupment estimate is not good to the point (owner 2026-10-22, "23 to 40% is false accuracy"). */
function roundToFive(v: number): number {
  return Math.round(v / 5) * 5;
}

/**
 * The estimate range the site shows when getRecoupmentDisplayMode is 'analyst',
 * else null: not on a recouped, nonprofit or tour-stop record, and on a closed
 * Fizzle or Flop only when it agrees with the label.
 *
 * The range spans the analyst's estimate and our model's central figure
 * (owner 2026-10-22): two estimates from the same grosses that disagree by
 * 15-37 points on a third of shows, neither proven better. The model joins
 * when it passes the quality floor and the display guard, or when the guard
 * held it only for being too uncertain, for disagreeing with an outside
 * estimate, or for sitting far below costs: its own bar would overstate how
 * sure it is, while one end of a range spanning the analyst's says exactly
 * that. On a closed Fizzle or Flop the model, and the widened range, must
 * agree with the label. withModel says the model widened or met the range,
 * for the credit line. Both ends round to the nearest 5.
 */
export function getDisplayableEstimateRange(commercial: RecoupmentSignals): { range: [number, number]; withModel: boolean } | null {
  if (commercial.recouped === true || hasNoInvestorsToRepay(commercial)) return null;
  const owner = ourRecoupRangePct(commercial);
  if (owner) {
    const range = roundedRange(owner as [number, number]);
    if (isFinalClosedOutcome(commercial) && !estimateFitsDesignation(range, commercial.designation, true)) return null;
    // The owner is correcting the model; that model must not widen this range.
    return { range, withModel: false };
  }
  const analyst = analystRange(commercial);
  if (!analyst) return null;
  const finalClosed = isFinalClosedOutcome(commercial);
  // The label check reads the rounded range the reader sees: rounding can move
  // a midpoint across the Fizzle line (Flop 0-58, mid 29, shows 0-60, mid 30).
  const fits = (range: [number, number]) => !finalClosed || estimateFitsDesignation(range, commercial.designation);
  const analystShown = roundedRange(analyst);
  if (!fits(analystShown)) return null;
  const model = rangeModel(commercial);
  if (model && meetsModelQualityFloor(commercial) && (!finalClosed || estimateFitsDesignation(model, commercial.designation))) {
    const central = Math.max(0, model[1]);
    const spanned = roundedRange([Math.min(analyst[0], central), Math.max(analyst[1], central)]);
    // Widened, the range must still agree with a closed label; else the analyst's alone.
    if (fits(spanned)) return { range: spanned, withModel: true };
  }
  return { range: analystShown, withModel: false };
}

/**
 * Both ends to the nearest 5. A low end of 100+ stays: it reads "Est. recouped,
 * not yet announced". Else the range tops out below 100, as the model's does
 * (BRO-5073), at the highest multiple of 5 under it.
 */
function roundedRange([lo, hi]: [number, number]): [number, number] {
  if (lo >= 100) return [roundToFive(lo), roundToFive(hi)];
  const top = Math.floor(RUNNING_SHOWN_MAX / 5) * 5;
  return [Math.min(roundToFive(lo), top), Math.min(roundToFive(hi), top)];
}

/** The range of getDisplayableEstimateRange, for callers that need only the numbers. */
export function getDisplayableAnalystRange(commercial: RecoupmentSignals): [number, number] | null {
  return getDisplayableEstimateRange(commercial)?.range ?? null;
}

/**
 * The model display guard (BRO-4989, scripts/lib/model-display-guard.js),
 * applied once where the site loads commercial.json. Hidden (fewer than 12
 * played weeks, central outside [-25, 150], or two independent estimates
 * disagree by more than 25 points, the range is more than 60 points wide, or the
 * show is running while RUNNING_MODEL_BAR_ENABLED is off or its type is not
 * in RUNNING_MODEL_BAR_TYPES):
 * modelRecoupmentPct becomes null and modelDisplayHold says
 * why. Shown: negative values become 0 and modelBelowCosts is set, so the
 * negative number never reaches a page.
 */
export function applyModelDisplayGuard(
  data: ShowCommercial,
  show: { previewsStartDate?: string | null; openingDate?: string | null; closingDate?: string | null; status?: string | null; type?: string | null } | undefined,
  now: Date = new Date()
): ShowCommercial {
  if (!data.modelRecoupmentPct) return data;
  const running = isRunning(show, now);
  // Known to be over (BRO-5502): no "too early" hold, while the type rule and past-100 holds still apply.
  const closed = !!show && !running;
  // Running shows: pre-credit unless the credit is cited (displayBasis, BRO-5073).
  const basis = displayBasis({ pct: data.modelRecoupmentPct, exCreditPct: data.modelReturnedExCreditPct, creditCounted: data.modelTaxCreditCounted, running });
  const pct = basis.pct as [number, number, number];
  const creditBasis = basis.creditBasis ? { modelCreditBasis: basis.creditBasis } : {};
  const g = modelDisplayGuard({
    pct,
    playedWeeks: show ? playedWeeks(show, now) : 0,
    independent: independentEstimate(data),
    running,
    closed,
    showType: show ? show.type ?? null : undefined,
  });
  if (!g.show) {
    // Far below 0 (Schmigadoon -169) hides the number, not the fact.
    const below = g.reason === 'out-of-bounds' && pct[1] < 0;
    return {
      ...data,
      modelRecoupmentPct: null,
      modelHeldRange: pct,
      modelDisplayHold: g.reason ?? 'no-model',
      ...creditBasis,
      ...(below ? { modelBelowCosts: true } : {}),
    };
  }
  return { ...data, modelRecoupmentPct: g.shown as [number, number, number], ...creditBasis, ...(g.belowCosts ? { modelBelowCosts: true } : {}) };
}

/**
 * Why a held model estimate is not shown, in reader words, for the cell or
 * card that would otherwise print a bare dash (BRO-4989). Null when nothing
 * was held: no model, a recouped or settled closed show, a nonprofit, or a
 * model below the quality floor (that one never displays, held or not).
 */
export function getModelHoldLabel(
  commercial: RecoupmentSignals & Pick<ShowCommercial, 'modelDisplayHold' | 'modelBelowCosts'>
): string | null {
  const hold = commercial.modelDisplayHold;
  if (!hold || hold === 'no-model') return null;
  if (commercial.recouped === true || isFinalClosedOutcome(commercial)) return null;
  if (hasNoInvestorsToRepay(commercial) || !meetsModelQualityFloor(commercial)) return null;
  if (commercial.modelBelowCosts) return commercial.status === 'closed' ? 'Lost money: est. 0% returned' : 'Losing money so far';
  // "Too early" is wrong once the run is over (BRO-5020).
  if (hold === 'few-weeks') return commercial.status === 'closed' ? 'Not enough data to estimate' : 'Too early to estimate';
  if (hold === 'estimates-disagree') return 'Estimates disagree';
  if (hold === 'too-uncertain') return 'Too uncertain to estimate';
  if (hold === 'awaiting-truth') return 'Not enough reported data yet';
  // Never hint at a recoupment the producers have not announced (BRO-5073).
  if (hold === 'past-100-unannounced') return 'Recoupment not announced';
  // Low end of the range at 100%+: say so, as an estimate (owner, BRO-5073).
  if (hold === 'estimated-recouped') return 'Estimated to have recouped, not yet announced';
  return 'Estimate unavailable';
}

/**
 * BRO-5313: "Investors got back about 55-60% (Broadway Journal, Oct 2026)" for a
 * closed show with a final designation, only when the loader found a trade-stated
 * figure (reportedReturn). Null otherwise; never built from the model or an inference.
 */
export function getReportedReturnLine(
  commercial: Pick<ShowCommercial, 'reportedReturn' | 'designation' | 'recouped'> & Pick<RecoupmentSignals, 'status' | 'productionType'>
): string | null {
  if (!isFinalClosedOutcome(commercial) || commercial.recouped === true || hasNoInvestorsToRepay(commercial)) return null;
  return reportedReturnLabel(commercial.reportedReturn ?? null);
}

/** What the /biz % Recouped cell says, decided once for the cell, its sort and the coverage audit (BRO-5502). */
export type RecoupedCellSummary =
  | { kind: 'recouped' }
  | { kind: 'reported'; lo: number; hi: number; outlet: string; asOf: string | null }
  | { kind: 'analyst'; range: [number, number]; withModel: boolean; asOf: string | null; url: string | null; ours: boolean }
  | { kind: 'model'; pct: [number, number, number] }
  | { kind: 'loss'; text: string }
  | { kind: 'reason'; text: string };

type CellSignals = RecoupmentSignals &
  Pick<ShowCommercial, 'designation' | 'modelDisplayHold' | 'modelBelowCosts' | 'reportedReturn' | 'analystRecoupAsOf' | 'analystRecoupUrl'> & {
    designationBasis?: ShowCommercial['designationBasis'] | null;
    capitalization?: number | null;
  };

/**
 * The % Recouped cell, most authoritative first: a recoupment record, a
 * trade-reported return on a closed show, the analyst's estimate, our model,
 * the loss phrase of a closed loss label, then the reason there is no figure.
 * Every commercial row says something; none prints a bare dash (owner,
 * 2026-10-16: "so many gaps").
 */
export function getRecoupedCellSummary(row: CellSignals): RecoupedCellSummary {
  const mode = getRecoupmentDisplayMode(row);
  if (mode === 'announced') return { kind: 'recouped' };
  const rr = row.reportedReturn;
  if (rr && getReportedReturnLine(row)) return { kind: 'reported', lo: rr.lo, hi: rr.hi, outlet: rr.outlet, asOf: rr.asOf };
  if (mode === 'analyst') {
    const est = getDisplayableEstimateRange(row)!;
    const owner = ourRecoupRangePct(row);
    return {
      kind: 'analyst', range: est.range, withModel: est.withModel,
      asOf: owner ? row.ourRecoupEstimateAsOf ?? null : row.analystRecoupAsOf ?? null,
      url: owner ? null : row.analystRecoupUrl ?? null,
      ours: !!owner || !row.analystRecoupPct,
    };
  }
  if (mode === 'model') return { kind: 'model', pct: row.modelRecoupmentPct! };
  if (isClosedWithoutRecouping(row)) {
    return { kind: 'loss', text: lossOutcomePhrase({ designation: row.designation, designationBasis: row.designationBasis ?? undefined }, 'cell') };
  }
  const held = getModelHoldLabel(row);
  if (held) return { kind: 'reason', text: held };
  if (hasNoInvestorsToRepay(row)) return { kind: 'reason', text: row.designation === 'Tour Stop' ? 'Not applicable: tour stop' : 'Not applicable: nonprofit' };
  // Why there is no estimate: % recouped needs what the show cost to put up,
  // and our model needs what it costs to run.
  if (row.capitalization == null) return { kind: 'reason', text: 'Budget not disclosed' };
  if (row.modelDataQuality === 'low') return { kind: 'reason', text: 'Running costs not reported' };
  return { kind: 'reason', text: 'Not enough data to estimate' };
}

/** The model range when getRecoupmentDisplayMode would render it, else null. */
export function getDisplayableModelRange(
  commercial: RecoupmentSignals
): [number, number, number] | null {
  if (getRecoupmentDisplayMode(commercial) !== 'model') return null;
  return commercial.modelRecoupmentPct ?? null;
}

/**
 * The range the At Risk list judges by: the displayable model range, or, when
 * the display guard hid the bar (too few weeks, estimates disagree, out of
 * bounds), the range it held back, floored at 0. Hiding a number is about
 * what a page prints; it must not drop a show losing money off the list
 * (BRO-4989 ship-check). The card prints the hold reason, never this range.
 */
export function getAtRiskModelRange(
  commercial: RecoupmentSignals & Pick<ShowCommercial, 'modelDisplayHold' | 'modelHeldRange'>
): [number, number, number] | null {
  const range = getDisplayableModelRange(commercial);
  if (range) return range;
  const held = commercial.modelHeldRange;
  if (!held || !getModelHoldLabel({ ...commercial, modelRecoupmentPct: null })) return null;
  return held.map((v) => Math.max(0, v)) as [number, number, number];
}

/**
 * Weekly break-even used everywhere (show card, /biz at-risk list): the
 * model's break-even when it clears the quality floor, else the recorded
 * weekly running cost, else null. A model break-even below the running cost
 * is stale (the cost changed after the model ran; break-even = cost plus
 * royalties and rent), so the cost is shown instead (BRO-4985). An all-in
 * cost already holds the royalties and rent at the period's gross, so a
 * break-even below it is the model's real reading, not a stale one (BRO-6217).
 */
export function getBreakEven(
  commercial: Pick<ShowCommercial, 'modelBreakeven' | 'weeklyRunningCost' | 'weeklyRunningCostBasis' | 'modelDataQuality' | 'modelMethod'>
): number | null {
  const cost = commercial.weeklyRunningCost ?? null;
  if (commercial.modelBreakeven && meetsModelQualityFloor(commercial)) {
    const stale = cost != null && commercial.modelBreakeven < cost && commercial.weeklyRunningCostBasis !== 'all-in';
    return stale ? cost : commercial.modelBreakeven;
  }
  return cost;
}

type SourceList = ShowCommercial['sources'];

/** First trade-press or SEC source URL on the record, else null. */
export function getCitedSourceUrl(sources: SourceList): string | null {
  const hit = (sources ?? []).find(
    (s) => (s.type === 'trade' || s.type === 'sec') && typeof s.url === 'string' && /^https?:\/\//.test(s.url)
  );
  return hit?.url ?? null;
}

/**
 * The part of a commercial record the show page may send to the browser.
 * BizBuzzCard is a client component, so whatever object it receives lands in
 * the page's RSC payload (page source) even when the card never prints it.
 * This is an allowlist of the fields the card reads, with every free-text
 * field passed through publicSourceText; research metadata (deepResearch,
 * modelWarnings, classifiedReason, estimatedRecoupmentSource, source
 * excerpts...) never leaves the server. Call it in the server component.
 */
/**
 * Plain-words names for the model inputs that are guesses (BRO-5849), by what
 * kind of guess: never "lead", never the forum's name (policy BRO-5020).
 * A Form D ceiling is a disclosed maximum and has its own "up to" wording, so
 * it is not listed. Empty when every input is a figure the record states.
 */
export function estimatedInputNotes(commercial: Pick<ShowCommercial, 'modelInputBasis' | 'costMethodology'>): string[] {
  const out: string[] = [];
  for (const { input, basis } of commercial.modelInputBasis ?? []) {
    if (basis === 'comparables') out.push(`${input === 'capitalization' ? 'capitalization' : 'weekly running cost'} estimated from similar shows, not this show's own figures`);
    else if (basis === 'estimate' && input === 'capitalization') out.push('capitalization is an unconfirmed estimate');
    else if (basis !== 'estimate') continue;
    else if (commercial.costMethodology === 'reddit-standard') out.push('weekly running cost is a fan-forum estimate, unconfirmed');
    else if (commercial.costMethodology === 'industry-estimate') out.push('weekly running cost is an industry estimate, unconfirmed');
    else out.push('weekly running cost is an unconfirmed estimate');
  }
  return out;
}

export function toPublicShowCommercial(commercial: ShowCommercial): ShowCommercial {
  const rawRecoupedSource = commercial.recoupedSource ?? null;
  const recoupedSource =
    publicSourceText(rawRecoupedSource) ??
    // Keep the "no announcement" signal getRecoupmentAttribution reads, without the internal wording.
    (rawRecoupedSource && saysRecoupmentUnannounced(rawRecoupedSource) ? NOT_ANNOUNCED_LABEL : null);
  const estimatedInputs = estimatedInputNotes(commercial);
  return {
    designation: commercial.designation,
    returnSnapshotAsOf: returnSnapshotDate(commercial),
    capitalization: commercial.capitalization,
    capitalizationSource: publicSourceText(commercial.capitalizationSource),
    ...(commercial.capitalizationBasis ? { capitalizationBasis: commercial.capitalizationBasis } : {}),
    weeklyRunningCost: commercial.weeklyRunningCost,
    weeklyRunningCostSource: publicSourceText(commercial.weeklyRunningCostSource),
    ...(commercial.weeklyRunningCostBasis ? { weeklyRunningCostBasis: commercial.weeklyRunningCostBasis } : {}),
    costMethodology: commercial.costMethodology,
    isEstimate: commercial.isEstimate,
    ...(estimatedInputs.length ? { estimatedInputs } : {}),
    recouped: commercial.recouped,
    recoupedDate: commercial.recoupedDate,
    recoupedWeeks: commercial.recoupedWeeks,
    recoupedSource,
    humanReviewedDesignation: commercial.humanReviewedDesignation,
    ...(commercial.designationBasis ? { designationBasis: commercial.designationBasis } : {}),
    ...(commercial.likelyOutcome ? { likelyOutcome: commercial.likelyOutcome, likelyOutcomeBasis: commercial.likelyOutcomeBasis ?? 'model' } : {}),
    notes: publicNotesText(commercial) ?? undefined,
    sources: commercial.sources?.map(({ type, url, date }) => ({ type, url, date })),
    investorMultiple: commercial.investorMultiple,
    modelInvestorMultiple: commercial.modelInvestorMultiple,
    nonprofitOrg: getNonprofitProducer(commercial) ?? undefined,
    // A nonprofit run that became a commercial run (BRO-5508): the card's producer line names the switch.
    ...(conversionOf(commercial) ? { commercialConversion: conversionOf(commercial) } : {}),
    // An enhancement deal has investors to repay (hasNoInvestorsToRepay); the card needs it to match the table.
    ...(commercial.productionType ? { productionType: commercial.productionType } : {}),
    modelRecoupmentPct: commercial.modelRecoupmentPct,
    // Display-guard outputs (applyModelDisplayGuard): the show-page bar reads these.
    ...(commercial.modelBelowCosts ? { modelBelowCosts: true } : {}),
    ...(commercial.modelDisplayHold ? { modelDisplayHold: commercial.modelDisplayHold } : {}),
    // A held model's central figure can still bound the analyst + model range (getDisplayableEstimateRange).
    ...(publicHeldRange(commercial) ? { modelHeldRange: publicHeldRange(commercial) } : {}),
    ...(commercial.modelCreditBasis ? { modelCreditBasis: commercial.modelCreditBasis } : {}),
    modelBreakeven: commercial.modelBreakeven,
    modelDataQuality: commercial.modelDataQuality,
    modelMethod: commercial.modelMethod,
    ...(commercial.reportedReturn ? { reportedReturn: commercial.reportedReturn } : {}),
    // The analyst's published estimate (BRO-5502): numbers, a date and the post's URL only.
    ...(commercial.analystRecoupPct ? {
      analystRecoupPct: commercial.analystRecoupPct,
      analystRecoupAsOf: commercial.analystRecoupAsOf ?? null,
      analystRecoupUrl: commercial.analystRecoupUrl ?? null,
    } : {}),
    ...(commercial.ourEstimateRangePct ? { ourEstimateRangePct: commercial.ourEstimateRangePct } : {}),
    ...(commercial.ourRecoupEstimatePct != null ? { ourRecoupEstimatePct: commercial.ourRecoupEstimatePct, ourRecoupEstimateAsOf: commercial.ourRecoupEstimateAsOf ?? null } : {}),
  };
}

/**
 * The nonprofit company behind a production (commercial.json nonprofitOrg:
 * Manhattan Theatre Club, Lincoln Center Theater, Roundabout, Second Stage),
 * when publishable. Null for commercial productions.
 */
export function getNonprofitProducer(commercial: Pick<ShowCommercial, 'nonprofitOrg'>): string | null {
  return publicSourceText(commercial.nonprofitOrg);
}

/**
 * The line under the designation naming the nonprofit producer: a Nonprofit
 * show reads "A Manhattan Theatre Club production (nonprofit)"; a commercial
 * outcome on a nonprofit production (an enhancement) reads "Nonprofit
 * producer: Lincoln Center Theater"; a nonprofit run that became a commercial
 * run says when (BRO-5508). Null when there is no nonprofit producer.
 */
export function getNonprofitProducerLine(
  commercial: Pick<ShowCommercial, 'nonprofitOrg' | 'designation' | 'commercialConversion'> & { productionType?: ShowCommercial['productionType'] | null }
): string | null {
  const org = getNonprofitProducer(commercial);
  if (!org) return null;
  const conversion = conversionOf(commercial);
  if (conversion) {
    const when = formatEstimateDate(conversion.date, 'short');
    return `Began as a ${org} nonprofit production, then switched to a commercial run${when ? ` in ${when}` : ''}`;
  }
  if (commercial.designation !== 'Nonprofit') return `Nonprofit producer: ${org}`;
  // An enhancement deal raised commercial money, so its % recouped shows (BRO-5502); say why.
  return commercial.productionType === 'enhancement'
    ? `A ${org} production (nonprofit, with commercial enhancement investors)`
    : `A ${org} production (nonprofit)`;
}

/**
 * The /biz table's small line under the designation: the nonprofit company,
 * plus when its run became a commercial run (BRO-5508). Null with none.
 */
export function getNonprofitTag(
  row: { nonprofitOrg?: string | null; commercialConversion?: ShowCommercial['commercialConversion'] }
): string | null {
  if (!row.nonprofitOrg) return null;
  const conversion = conversionOf(row);
  if (!conversion) return row.nonprofitOrg;
  const when = formatEstimateDate(conversion.date, 'short');
  return when ? `${row.nonprofitOrg} · commercial from ${when}` : `${row.nonprofitOrg} · went commercial`;
}

/** Re-exported for client components: one rule for who has investors to repay (BRO-5502). */
export { hasNoInvestorsToRepay };

/** Which source text may be printed, and which capitalization is our estimate: shared with the newsletter (BRO-5517). */
export { publicSourceText, isEstimatedCapitalization };
/** Which capitalization is a ceiling that prints "up to $X" (BRO-5660). */
export { isMaximumCapitalization };

/** costMethodology values whose weekly running cost is our estimate, not a reported figure. */
export const ESTIMATED_COST_METHODS: ReadonlySet<string> = new Set(['industry-estimate', 'deep-research', 'reddit-standard']);

/**
 * True when the weekly cost reads as an estimate: an estimated method, or a
 * figure with no publishable source. A cost labeled trade-reported that cites
 * nothing cannot be shown as reported (BRO-4666: 27 of 28 "reported" costs
 * had no source, several equal to Reddit estimates to the dollar).
 */
function isEstimatedCostBasis(
  commercial: Pick<ShowCommercial, 'costMethodology' | 'weeklyRunningCostSource'>
): boolean {
  if (commercial.costMethodology && ESTIMATED_COST_METHODS.has(commercial.costMethodology)) return true;
  return !publicSourceText(commercial.weeklyRunningCostSource);
}

/** True when the weekly running cost should carry the "~" estimate marker. */
export function isEstimatedRunningCost(
  commercial: Pick<ShowCommercial, 'costMethodology' | 'isEstimate' | 'weeklyRunningCostSource'>
): boolean {
  if (commercial.isEstimate?.weeklyRunningCost === true) return true;
  return isEstimatedCostBasis(commercial);
}

/**
 * Text for the "Weekly cost source:" line: "Estimate" for an estimated method
 * or an uncited figure (never the raw research note), otherwise the
 * publishable source text.
 */
export function getWeeklyCostSourceLabel(
  commercial: Pick<ShowCommercial, 'costMethodology' | 'weeklyRunningCostSource'>
): string {
  if (isEstimatedCostBasis(commercial)) return 'Estimate';
  return publicSourceText(commercial.weeklyRunningCostSource) as string;
}

const NOT_ANNOUNCED_LABEL = 'Not publicly announced';

/**
 * A recouped:true record whose recoupment was never announced: the record
 * flags it (isEstimate.recouped, which the record checks require its
 * recoupedSource to explain: BRO-5562) or its recoupedSource says so. Only ever downgrades the
 * label. humanReviewedDesignation is NOT a signal: it marks any hand-checked
 * record, and announced ones (Purpose, Gutenberg) carry it too (BRO-4623).
 */
export function isUnannouncedRecoupment(
  commercial: Pick<ShowCommercial, 'recouped' | 'isEstimate' | 'recoupedSource'>
): boolean {
  if (commercial.recouped !== true) return false;
  return commercial.isEstimate?.recouped === true || saysRecoupmentUnannounced(commercial.recoupedSource);
}

export interface RecoupmentAttribution {
  /** "Recouped, December 2014", "Recouped, reported April 2026" (report month after closing), or "Recouped" when the date is unknown. */
  headline: string;
  /** "Not publicly announced" or null. */
  qualifier: string | null;
  /** First trade/SEC source URL on the record. */
  sourceUrl: string | null;
  /** recoupedSource when publishable (publicSourceText), else a generic label for sourceUrl, else null. */
  sourceText: string | null;
  /** How firmly to read the recoupment: high only with a trade/SEC source and no "not announced" signal. */
  confidence: { level: 'high' | 'medium'; label: string; basis: string };
}

/**
 * Neutral wording for a recouped:true record (BRO-4623 P0-8). Never says
 * "Producers announced" (Disney shows were labelled that way though their own
 * source says Disney never announces), and only "High confidence" when the
 * record carries a trade-press or SEC source URL.
 */
export function getRecoupmentAttribution(commercial: ShowCommercial, closingDate?: string | null): RecoupmentAttribution {
  const date = formatRecoupedDate(commercial.recoupedDate);
  // A date we estimated (isEstimate.recoupedDate) prints "~": the source reports the recoupment, not when (BRO-5568).
  // A report month after the run closed is when it was reported, not when it happened (BRO-5779).
  const reportedLate = commercial.isEstimate?.recoupedDate !== true && recoupReportedAfterClosing(commercial.recoupedDate, closingDate);
  const headline = date
    ? reportedLate
      ? `Recouped, reported ${date}`
      : `Recouped, ${commercial.isEstimate?.recoupedDate === true ? '~' : ''}${date}`
    : 'Recouped';
  const sourceUrl = getCitedSourceUrl(commercial.sources);
  const notAnnounced = isUnannouncedRecoupment(commercial);
  const qualifier = notAnnounced ? NOT_ANNOUNCED_LABEL : null;

  const dateIsEstimate = commercial.isEstimate?.recoupedDate === true;
  let confidence: RecoupmentAttribution['confidence'];
  if (sourceUrl && !notAnnounced && !dateIsEstimate) {
    const basis = (commercial.sources ?? []).some((s) => s.type === 'sec' && s.url === sourceUrl)
      ? 'SEC filing'
      : 'Trade press report';
    confidence = { level: 'high', label: 'High confidence', basis };
  } else {
    confidence = {
      level: 'medium',
      label: 'Medium confidence',
      basis: qualifier ?? (dateIsEstimate ? 'Recoupment reported, date is our estimate' : 'Industry reports, no linked source'),
    };
  }
  const isSec = !!sourceUrl && (commercial.sources ?? []).some((s) => s.type === 'sec' && s.url === sourceUrl);
  // A source that only repeats the qualifier (a sanitized record, see
  // toPublicShowCommercial) adds nothing as a "Source:" line.
  const publicSource = publicSourceText(commercial.recoupedSource);
  const sourceText =
    (publicSource && publicSource !== NOT_ANNOUNCED_LABEL ? publicSource : null) ??
    (sourceUrl ? (isSec ? 'SEC filing' : 'Trade press report') : null);
  return { headline, qualifier, sourceUrl, sourceText, confidence };
}

/**
 * Investor multiple for the /biz Return column: only a figure the record
 * reports (investorMultiple) on a record with a trade/SEC source. The model's
 * percent-of-capitalization is NOT an investor return (its denominator adds a
 * reserve, and once netted out SVOG grants, which put Chicago at ~958x), so there is
 * no modeled fallback.
 */
export function getReportedInvestorMultiple(
  commercial: Pick<ShowCommercial, 'investorMultiple' | 'sources'>
): number | null {
  const m = commercial.investorMultiple;
  if (typeof m !== 'number' || !isFinite(m) || m <= 0) return null;
  return getCitedSourceUrl(commercial.sources) ? m : null;
}

/** A range whose high end is more than this multiple of its low end says too little to print (Phantom 1.0-9.1x). */
const MAX_RETURN_RANGE_SPREAD = 2;

/**
 * Our model's estimated investor return for a CLOSED show on the winning
 * side, as a [low, high] multiple of the money put in (owner 2026-10-29,
 * BRO-6555: a range, never one number). After the producers' share, NY tax
 * credit included. Running shows get none: their multiple projects to the
 * closing date, so it is not money returned yet. null when a cited multiple
 * exists (that one is shown instead), the label is not a win, the model's
 * middle is under 1x (it contradicts the win), or the range is too wide.
 * The low end is floored at 1x: a win means investors got their money back.
 */
export function getEstimatedReturnRange(
  commercial: Pick<ShowCommercial, 'designation' | 'modelInvestorMultiple' | 'investorMultiple' | 'sources'>,
  status: string | null | undefined
): [number, number] | null {
  if (status !== 'closed') return null;
  if (getReportedInvestorMultiple(commercial) != null) return null;
  if (!(RECOUPED_DESIGNATIONS as readonly string[]).includes(commercial.designation)) return null;
  const m = commercial.modelInvestorMultiple;
  if (!m || !m.every((v) => typeof v === 'number' && isFinite(v))) return null;
  const [lo, mid, hi] = [...m].sort((a, b) => a - b);
  if (mid < 1) return null;
  const floor = Math.max(lo, 1);
  if (hi > floor * MAX_RETURN_RANGE_SPREAD) return null;
  return [floor, hi];
}

/** "1.0–1.3x"; a range that rounds to one figure reads "about 1.2x". */
export function formatReturnRange([lo, hi]: [number, number]): string {
  const a = lo.toFixed(1);
  const b = hi.toFixed(1);
  return a === b ? `about ${a}x` : `${a}–${b}x`;
}

export interface DesignationDisplay {
  label: string;
  description: string;
  textClass: string;
  icon: string;
  isUndisclosed: boolean;
}

/** Whether the Profitability Scorecard has anything to show (it renders nothing otherwise). */
export function hasCommercialCard(
  c: Pick<ShowCommercial, 'capitalization' | 'recouped' | 'designation'> & Partial<Pick<ShowCommercial, 'analystRecoupPct' | 'ourEstimateRangePct' | 'ourRecoupEstimatePct' | 'commercialConversion'>>
): boolean {
  // A TBD show with only the analyst's estimate (Beaches: ~0% recouped) or a
  // switch to a commercial run still has a card to show (BRO-5508).
  return !!(c.capitalization || c.recouped !== null || c.designation !== 'TBD' || c.analystRecoupPct || c.ourEstimateRangePct || ourRecoupRangePct(c) || conversionOf(c));
}

/** The public caveat for a loss label that rests on silence (owner policy B, BRO-5020). */
export const LOSS_ON_SILENCE_CAVEAT = 'Based on no recoupment being announced';

/**
 * The public caveat for a designation that is our estimate (owner 2026-10-24,
 * BRO-6158): a closed show no source has reported on still gets our best
 * designation, marked as ours and open to change.
 */
export const DESIGNATION_ESTIMATE_CAVEAT = 'Our estimate, not a reported result. We update it if a recoupment is announced.';

type LossBasisSignals = Pick<ShowCommercial, 'designation' | 'designationBasis'>;

/**
 * True only for a loss label whose loss a source reported
 * (designationBasis 'reported-loss'). A label resting on silence, on our own
 * notes ('notes-stated') or on nothing recorded is not a reported fact, so it
 * never reads like one (checker, BRO-5020).
 */
export function isReportedLoss(c: LossBasisSignals | null | undefined): boolean {
  return !!c && isLossDesignation(c.designation) && c.designationBasis === 'reported-loss';
}

/**
 * The caveat a loss label carries unless a source reported the loss. Null
 * for a reported loss and for every other designation. Writers store only the
 * basis; this file is the one place the public words live. A designation
 * resting on our own estimate (basis 'model-estimate', loss label or
 * Trickle/Windfall) says so instead.
 */
export function lossBasisCaveat(c: LossBasisSignals | null | undefined): string | null {
  if (!c) return null;
  if (c.designationBasis === 'model-estimate') return DESIGNATION_ESTIMATE_CAVEAT;
  if (!isLossDesignation(c.designation)) return null;
  return isReportedLoss(c) ? null : LOSS_ON_SILENCE_CAVEAT;
}

/**
 * A loss label describes a show as it closed. Some shows recoup later, from
 * tours, licensing and other income after the Broadway run, so the card says
 * the label can change (owner 2026-10-18, BRO-5645).
 */
export const LOSS_CAN_CHANGE_NOTE = 'This can change if the show recoups later, from tours or licensing.';

/**
 * Our best guess at how a show did where no source says (BRO-5647):
 * "Likely: Flop", "Likely: Fizzle" or, on an Undisclosed show,
 * "Likely: Recouped", from likelyOutcomeDesignation, shown beside the label
 * and marked as ours. Pass the show's status: Undisclosed is a closed TBD.
 */
export function likelyOutcomeLine(c: Parameters<typeof likelyOutcomeDesignation>[0]): string | null {
  const d = likelyOutcomeDesignation(c);
  return d ? `Likely: ${d}` : null;
}

/**
 * What a Likely line rests on: an estimate the record carries from outside
 * (an analyst's range or an outside estimate), else our model. null with no line.
 */
export type LikelyOutcomeBasis = 'estimate' | 'model';
export function likelyOutcomeBasis(c: Parameters<typeof likelyOutcomeDesignation>[0]): LikelyOutcomeBasis | null {
  if (!likelyOutcomeDesignation(c)) return null;
  // The owner figure leads even when an outside estimate is also recorded.
  if (ourRecoupRangePct(c)) return 'model';
  return ownReturnedEstimatePct({ ...c, ourEstimateRangePct: undefined }) !== null ? 'estimate' : 'model';
}

/** The basis in words: the card prints LIKELY_OUTCOME_BASIS, the /biz cell's tooltip says LIKELY_OUTCOME_NOTE in full. */
export const LIKELY_OUTCOME_BASIS: Record<LikelyOutcomeBasis, string> = {
  model: 'our estimate from weekly grosses and costs',
  estimate: 'from an outside estimate of what investors got back',
};
export const LIKELY_OUTCOME_NOTE: Record<LikelyOutcomeBasis, string> = {
  model: 'Our estimate from weekly grosses and costs. No source has reported what investors got back.',
  estimate: 'From an outside estimate of what investors got back. No source has reported the actual figure.',
};

/** The can-change note for a loss label; null for every other designation. */
export function lossCanChangeNote(c: Pick<ShowCommercial, 'designation' | 'designationBasis'> | null | undefined): string | null {
  // An estimate's caveat already says it updates; the extra note would repeat it.
  return c && isLossDesignation(c.designation) && c.designationBasis !== 'model-estimate' ? LOSS_CAN_CHANGE_NOTE : null;
}

/**
 * The research notes the show card prints under "Show details". On a loss
 * label no source reported, our notes ("closed without recouping, investors
 * got nothing") would read as a reported fact, so they stay off the page and
 * the caveat speaks instead (checker, BRO-5020).
 */
export function publicNotesText(
  c: LossBasisSignals & Pick<ShowCommercial, 'notes'>
): string | null {
  if (lossBasisCaveat(c)) return null;
  return publicSourceText(c.notes);
}

/**
 * Every public phrase that says a show lost money goes through here, so an
 * unreported loss never reads as "did not recoup":
 *  - 'cell'    the /biz table's % column ("Did not recoup" / "No recoupment announced";
 *              a reported Did Not Recoup says what is missing instead, since its
 *              label beside it already says it did not recoup, BRO-5636)
 *  - 'closing' the /biz timeline ("closed as a flop" / "closed without recouping" /
 *              "closed with no recoupment announced"; "closed" for any other label)
 */
export function lossOutcomePhrase(c: LossBasisSignals, form: 'cell' | 'closing'): string {
  const isLoss = isLossDesignation(c.designation);
  const reported = isReportedLoss(c);
  if (form === 'cell') {
    if (!reported) return 'No recoupment announced';
    return c.designation === 'Did Not Recoup' ? 'Amount returned not reported' : 'Did not recoup';
  }
  if (!isLoss) return 'closed';
  if (!reported) return 'closed with no recoupment announced';
  return c.designation === 'Flop' ? 'closed as a flop' : 'closed without recouping';
}

/**
 * What to call a designation on screen. A CLOSED show still stored as TBD
 * reads "Undisclosed: Closed; outcome not announced" instead of "TBD: still
 * running". Display only; commercial.json keeps TBD. One that announced
 * recoupment reads "Recouped · return undisclosed": the outcome was announced,
 * only the investor return was not (BRO-5020, The Piano Lesson).
 */
export function getDesignationDisplay(
  designation: ShowCommercial['designation'],
  status: string | null | undefined,
  recouped?: boolean | null
): DesignationDisplay {
  if (designation === 'TBD' && status === 'closed') {
    const d = recouped === true ? RECOUPED_UNDISCLOSED_DESIGNATION : UNDISCLOSED_DESIGNATION;
    return {
      label: d.name,
      description: d.description,
      textClass: d.color,
      icon: d.icon,
      isUndisclosed: d === UNDISCLOSED_DESIGNATION,
    };
  }
  const style = getDesignationBadgeStyle(designation);
  return {
    label: designation,
    description: (designation === 'TBD' && tbdStatusDescription(status)) || style.description,
    textClass: style.textClass,
    icon: style.icon,
    isUndisclosed: false,
  };
}

/** TBD_STATUS_DESCRIPTIONS for a status it names, else null. */
function tbdStatusDescription(status: string | null | undefined): string | null {
  return status && Object.prototype.hasOwnProperty.call(TBD_STATUS_DESCRIPTIONS, status)
    ? TBD_STATUS_DESCRIPTIONS[status as keyof typeof TBD_STATUS_DESCRIPTIONS]
    : null;
}

const PCT_CAP = 100;

function pctText(value: number): string {
  return value >= PCT_CAP ? '100%+' : `${value}%`;
}

// An investor cannot get back less than nothing (BRO-4989 checker #5).
const BELOW_COSTS_VALUE = '0% returned';
const BELOW_COSTS_NOTE = 'losing money so far';
// A closed run's loss is over, not ongoing (BRO-5502).
const BELOW_COSTS_FINAL_NOTE = 'lost money';

export interface ModelRecoupmentLabels {
  /** Rounded, clamped at 0. */
  low: number;
  central: number;
  high: number;
  /** "72%" or "100%+" (the model's % of capitalization is never shown past 100). */
  valueText: string;
  /** "Est. 72% recouped" */
  label: string;
  /** "Range: 55–88%" / "Range: 80%–100%+" / null when there is no spread. */
  rangeLabel: string | null;
  ariaLabel: string;
  /** Progress-bar fill, 0-100. */
  barWidth: number;
  /** "losing money so far" ("lost money" once the run is over) when the model central is below 0, else null. */
  belowCostsNote: string | null;
}

/**
 * Labels for a modeled recoupment estimate. Above 100% the model only says
 * "past capitalization": its denominator is not what investors put in, so the
 * old "~Nx returned to investors" regime (Hamilton "~159x") is gone. Always
 * labelled as an estimate, with the range.
 */
export function getModelRecoupmentLabels(
  estimatedPct: [number, number] | [number, number, number],
  { belowCosts = false, final = false }: { belowCosts?: boolean; final?: boolean } = {}
): ModelRecoupmentLabels {
  const belowNote = final ? BELOW_COSTS_FINAL_NOTE : BELOW_COSTS_NOTE;
  const isModel = estimatedPct.length === 3;
  // Clamp at 0: the model can emit negative percentages for deep flops
  // (e.g. cabaret-2024 [-168, -120, -74]); "-120% recouped" is nonsense copy.
  // Shown to the nearest 5, as the estimate range is (owner 2026-10-22: "23 to 40%
  // is false accuracy"); a figure under 100 never rounds up to it (BRO-5073).
  const shown = (v: number) => Math.max(0, v >= PCT_CAP ? roundToFive(v) : Math.min(roundToFive(v), Math.floor((PCT_CAP - 1) / 5) * 5));
  const low = shown(Math.min(...estimatedPct));
  const high = shown(Math.max(...estimatedPct));
  const central = isModel ? shown(estimatedPct[1]) : Math.max(0, Math.round((low + high) / 2));
  const valueText = pctText(central);

  let label: string;
  if (isModel && belowCosts) {
    label = `${BELOW_COSTS_VALUE} · ${belowNote}`;
  } else if (isModel) {
    label = `Est. ${valueText} recouped`;
  } else if (low === high || low >= PCT_CAP) {
    label = `Est. ~${pctText(low)} recouped`;
  } else if (high >= PCT_CAP) {
    label = `Est. ~${low}%–100%+ recouped`;
  } else {
    label = `Est. ~${low}–${high}% recouped`;
  }

  let rangeLabel: string | null = null;
  if (isModel && low !== high) {
    if (low >= PCT_CAP) rangeLabel = 'Range: 100%+ in every case';
    else if (high >= PCT_CAP) rangeLabel = `Range: ${low}%–100%+`;
    else rangeLabel = `Range: ${low}–${high}%`;
  }

  // A [low, high] estimate (an analyst's) is read as its range, never as a midpoint it did not state (BRO-5502).
  const ariaLabel = isModel && belowCosts
    ? `Estimated ${BELOW_COSTS_VALUE}, ${belowNote} (range ${pctText(low)} to ${pctText(high)})`
    : isModel || low === high
      ? `Estimated ${valueText} recouped (range ${pctText(low)} to ${pctText(high)})`
      : `Estimated ${pctText(low)} to ${pctText(high)} recouped`;
  return {
    low, central, high, valueText, label, rangeLabel, ariaLabel, barWidth: Math.min(central, PCT_CAP),
    belowCostsNote: isModel && belowCosts ? belowNote : null,
  };
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-13" → "Oct 2026" (short) or "Oct 13, 2026" (long); anything else → null. For estimate dates (BRO-5502). */
export function formatEstimateDate(iso: string | null | undefined, form: 'short' | 'long' = 'short'): string | null {
  const m = typeof iso === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  if (!m) return null;
  const month = SHORT_MONTHS[parseInt(m[2], 10) - 1];
  if (!month) return null;
  return form === 'long' ? `${month} ${parseInt(m[3], 10)}, ${m[1]}` : `${month} ${m[1]}`;
}

/** The note over every /biz table: what marks an estimate and whose it is (BRO-5502). */
export const ESTIMATE_SOURCES_NOTE = "~ and Est. mark estimates: musicals use an r/Broadway analyst's weekly figure, plays use our model.";

/**
 * Credit text for an analyst estimate in a /biz table cell. Generic on purpose
 * (owner decision 2026-10-20): the cell links to the post, and the show-page
 * card, tooltip and footnote carry the full name-and-subreddit credit.
 */
export const ANALYST_SHORT_LABEL = 'Analyst est.';

/** Link text on the show-page card for a switch to a commercial run reported on Reddit. */
export const CONVERSION_REDDIT_LABEL = 'r/Broadway analyst';

/**
 * Link text for where a switch to a commercial run is reported (BRO-5508):
 * the r/Broadway credit for a Reddit post, else "source".
 */
export function getConversionSourceLabel(url: string | null | undefined): string {
  try {
    if (url && /(^|\.)reddit\.com$/i.test(new URL(url).hostname)) return CONVERSION_REDDIT_LABEL;
  } catch { /* not a URL: plain label */ }
  return 'source';
}
export const ANALYST_FULL_LABEL = 'u/Boring_Waltz_9545, who posts weekly grosses analysis on r/Broadway';

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

export type SourceTextSegment = { kind: 'text'; text: string } | { kind: 'link'; href: string; label: string };

// A URL inside printed source text, ending on a character that is not
// sentence punctuation ("... primary_doc.xml." keeps its full stop as text).
const SOURCE_URL_RE = /(https?:\/\/[^\s<>"')]*[^\s<>"').,;:!?])/g;

/**
 * Printed source text split into plain text and links, so the show card can
 * render a cited filing or article as a short clickable label (the host name,
 * "sec.gov") instead of a raw URL clipped at the card's edge (BRO-5520). Only
 * http(s) URLs become links; anything else stays text.
 */
export function sourceTextSegments(text: string): SourceTextSegment[] {
  const out: SourceTextSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(SOURCE_URL_RE)) {
    const start = m.index ?? 0;
    let label: string;
    try {
      label = new URL(m[0]).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) });
    out.push({ kind: 'link', href: m[0], label });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/**
 * A source line shown as one link (the recoupment attribution, clamped to two
 * lines, where an inline link at the end would be cut off): its text without
 * raw URLs, pointing at the first URL it quotes, else at the fallback.
 */
export function sourceTextLink(text: string, fallbackHref: string | null): { label: string; href: string | null } {
  const segs = sourceTextSegments(text);
  const link = segs.find((seg) => seg.kind === 'link');
  // With the URLs gone, drop what only introduced them: an empty "()" and a
  // trailing "Also:" before a second citation (Oh, Mary!'s Playbill + Deadline).
  const label = segs
    .map((seg) => (seg.kind === 'text' ? seg.text : ''))
    .join('')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/(?:\s*\b(?:also|see also|and|via)\s*:?)+\s*$/i, '')
    .replace(/[\s,;:]+$/, '')
    .trim();
  return { label: label || (link && link.kind === 'link' ? link.label : text), href: link && link.kind === 'link' ? link.href : fallbackHref };
}
