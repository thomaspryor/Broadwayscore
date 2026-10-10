// Pure display-decision logic for the show-page Commercial Scorecard
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
import { getDesignationBadgeStyle, UNDISCLOSED_DESIGNATION } from '@/config/commercial';

export type RecoupmentDisplayMode = 'announced' | 'model' | 'none';

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
 * outcome. Its card and table row show the designation and cited facts only:
 * no model recoupment %, range, return or model confidence. (Lucky Guy read
 * "Flop" next to a model "~2.0x return"; Back to the Future "Flop" next to 86%.)
 */
export function isFinalClosedOutcome(signals: Pick<RecoupmentSignals, 'designation' | 'status'>): boolean {
  return signals.status === 'closed' && !!signals.designation && signals.designation !== 'TBD';
}

/**
 * The /biz "Did not recoup" cell. recouped:false alone is not evidence: the
 * stub enroller writes it on every new record, and nonprofit productions have
 * no investors to repay. Only a closed Fizzle or Flop (both defined as "closed
 * without recouping") makes the claim.
 */
export function isClosedWithoutRecouping(
  signals: Pick<RecoupmentSignals, 'designation' | 'status' | 'recouped'>
): boolean {
  return (
    signals.status === 'closed' &&
    signals.recouped === false &&
    (signals.designation === 'Fizzle' || signals.designation === 'Flop')
  );
}

/**
 * Which recoupment treatment the card renders:
 *  - 'announced': recouped:true — render the recoupment record, never the model.
 *    (Sprint 2 guarantees every recouped:true entry is cited or carries
 *    humanReviewedDesignation:true, but the rule keys off recouped alone so
 *    an uncited entry can never fall through to a dual display.)
 *  - 'none' for a closed show with a final designation (isFinalClosedOutcome),
 *    and for any Nonprofit production (no investors to repay).
 *  - 'model': model output exists and clears the quality floor.
 *  - 'none': nothing trustworthy to show. The legacy AI research estimate
 *    (estimatedRecoupmentPct) is deliberately NOT a fallback — it is
 *    ai-estimated by construction, exactly what the floor excludes.
 */
export function getRecoupmentDisplayMode(
  commercial: RecoupmentSignals
): RecoupmentDisplayMode {
  if (commercial.recouped === true) return 'announced';
  if (isFinalClosedOutcome(commercial)) return 'none';
  // Nonprofit productions raise no investor capital, so a modeled "% recouped" means nothing (BRO-4721).
  if (commercial.designation === 'Nonprofit') return 'none';
  if (commercial.modelRecoupmentPct && meetsModelQualityFloor(commercial)) {
    return 'model';
  }
  return 'none';
}

/** The model range when getRecoupmentDisplayMode would render it, else null. */
export function getDisplayableModelRange(
  commercial: RecoupmentSignals
): [number, number, number] | null {
  if (getRecoupmentDisplayMode(commercial) !== 'model') return null;
  return commercial.modelRecoupmentPct ?? null;
}

/**
 * Weekly break-even used everywhere (show card, /biz at-risk list): the
 * model's break-even when it clears the quality floor, else the recorded
 * weekly running cost, else null. A model break-even below the running cost
 * is stale (the cost changed after the model ran; break-even = cost plus
 * royalties and rent), so the cost is shown instead (BRO-4985).
 */
export function getBreakEven(
  commercial: Pick<ShowCommercial, 'modelBreakeven' | 'weeklyRunningCost' | 'modelDataQuality' | 'modelMethod'>
): number | null {
  const cost = commercial.weeklyRunningCost ?? null;
  if (commercial.modelBreakeven && meetsModelQualityFloor(commercial)) {
    return cost != null && commercial.modelBreakeven < cost ? cost : commercial.modelBreakeven;
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

// Internal research-tooling language that must never be printed as a public
// source line (records carried "GPT DR Batch 3: ~$800-900K...", "Trade press /
// deep research synthesis", "SEC filings (GPT Deep Research)"). The data text
// is being cleaned separately; this is the guard against it coming back.
// "Auto-enrolled stub; awaiting model + curation." is the placeholder note
// scripts/initialize-commercial-stub.js writes on every new record.
// "Per policy applied 2026-05-24: ..." and "Kept ... per owner review" are
// hand-edit notes about our own process (BRO-4669).
const INTERNAL_SOURCE_RE =
  /(?:chat)?gpt|deep[\s-]*research|\bDR\s*batch\b|\breddit\b|\bconsensus\b|\bsynthes[ie][sz]|\binferred\b|industry[\s-]*estimate|\bauto[\s-]*enroll?ed\b|\bawaiting\s+(?:the\s+)?(?:model|curation|research)\b|\bper\s+policy\b|\bowner\s+(?:review|decision|sign-?off)\b/i;

// Record field names written as code: "recouped:null because no public
// citation", "designation=Nonprofit" (BRO-4669). Case-sensitive (a lowercase
// field name) so prose like "Based on a True story" never matches; tested with
// URLs removed so a query string ("?type=D") is not mistaken for one.
const INTERNAL_TOKEN_RE = /\b[a-z][A-Za-z]*\s?[:=]\s?(?:true|false|null)\b|\b[a-z][A-Za-z]*=[A-Z]/;
const URL_RE = /\bhttps?:\/\/\S+/gi;

// Bracketed pipeline annotations appended to otherwise publishable notes:
// "[Auto-designated Fizzle: ...]" (scripts/cleanup-commercial-data.js) and
// "[PLAUSIBILITY WARNING: ...]" (the research/backfill scripts). Only the
// bracket is internal, so it is cut and the rest of the note survives.
const INTERNAL_ANNOTATION_RE = /\[\s*(?:auto[\s-]*(?:designated|enroll?ed)|plausibility\s+warning)\b[^\]]*\]/gi;

/**
 * Source text that is safe to print verbatim, else null. Callers render no
 * source line (or a methodology label) when this returns null.
 */
export function publicSourceText(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const stripped = text.replace(INTERNAL_ANNOTATION_RE, ' ');
  const trimmed = (stripped === text ? text : stripped.replace(/[ \t]{2,}/g, ' ')).trim();
  if (!trimmed) return null;
  if (INTERNAL_SOURCE_RE.test(trimmed) || INTERNAL_TOKEN_RE.test(trimmed.replace(URL_RE, ' '))) return null;
  return trimmed;
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
export function toPublicShowCommercial(commercial: ShowCommercial): ShowCommercial {
  const rawRecoupedSource = commercial.recoupedSource ?? null;
  const recoupedSource =
    publicSourceText(rawRecoupedSource) ??
    // Keep the "no announcement" signal getRecoupmentAttribution reads, without the internal wording.
    (rawRecoupedSource && NOT_ANNOUNCED_RE.test(rawRecoupedSource) ? NOT_ANNOUNCED_LABEL : null);
  return {
    designation: commercial.designation,
    capitalization: commercial.capitalization,
    capitalizationSource: publicSourceText(commercial.capitalizationSource),
    weeklyRunningCost: commercial.weeklyRunningCost,
    weeklyRunningCostSource: publicSourceText(commercial.weeklyRunningCostSource),
    costMethodology: commercial.costMethodology,
    isEstimate: commercial.isEstimate,
    recouped: commercial.recouped,
    recoupedDate: commercial.recoupedDate,
    recoupedWeeks: commercial.recoupedWeeks,
    recoupedSource,
    humanReviewedDesignation: commercial.humanReviewedDesignation,
    notes: publicSourceText(commercial.notes) ?? undefined,
    sources: commercial.sources?.map(({ type, url, date }) => ({ type, url, date })),
    investorMultiple: commercial.investorMultiple,
    nonprofitOrg: getNonprofitProducer(commercial) ?? undefined,
    modelRecoupmentPct: commercial.modelRecoupmentPct,
    modelBreakeven: commercial.modelBreakeven,
    modelDataQuality: commercial.modelDataQuality,
    modelMethod: commercial.modelMethod,
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
 * producer: Lincoln Center Theater". Null when there is no nonprofit producer.
 */
export function getNonprofitProducerLine(
  commercial: Pick<ShowCommercial, 'nonprofitOrg' | 'designation'>
): string | null {
  const org = getNonprofitProducer(commercial);
  if (!org) return null;
  return commercial.designation === 'Nonprofit' ? `A ${org} production (nonprofit)` : `Nonprofit producer: ${org}`;
}

/**
 * True when the capitalization should carry the "~" estimate marker: the
 * record flags it, or it has no publishable source. A cited capitalization is
 * a reported figure (BRO-4623) and prints plain; an uncited one cannot read
 * as reported, the same rule as the weekly cost (BRO-4666).
 */
export function isEstimatedCapitalization(
  commercial: Pick<ShowCommercial, 'isEstimate' | 'capitalizationSource'>
): boolean {
  if (commercial.isEstimate?.capitalization === true) return true;
  return !publicSourceText(commercial.capitalizationSource);
}

/** costMethodology values whose weekly running cost is our estimate, not a reported figure. */
const ESTIMATED_COST_METHODS: ReadonlySet<string> = new Set(['industry-estimate', 'deep-research', 'reddit-standard']);

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

// recoupedSource prose that says outright there was no announcement. Used
// ONLY to downgrade the label ("Not publicly announced"), never to claim an
// announcement, so a missed phrase under-claims instead of fabricating one.
// (Aladdin: "Disney never formally announces recoupment."; Lion King and
// Aladdin later read "Disney does not announce recoupments.", which the
// pattern missed, so both printed as announced: BRO-4722.)
const NOT_ANNOUNCED_RE =
  /\bno (?:public |producer |formal )?announcement\b|\bnever (?:formally |publicly )?announce[sd]?\b|\bnot (?:been )?(?:formally |publicly )?announced\b|\b(?:does|do|did) not (?:formally |publicly )?announce(?:s|ments?)?\b|\beditorial\b/i;

const NOT_ANNOUNCED_LABEL = 'Not publicly announced';

/**
 * A recouped:true record whose recoupment was never announced: the record
 * flags it (isEstimate.recouped, set by plan for Appropriate, Sweeney Todd and
 * Into the Woods) or its recoupedSource says so. Only ever downgrades the
 * label. humanReviewedDesignation is NOT a signal: it marks any hand-checked
 * record, and announced ones (Purpose, Gutenberg) carry it too (BRO-4623).
 */
export function isUnannouncedRecoupment(
  commercial: Pick<ShowCommercial, 'recouped' | 'isEstimate' | 'recoupedSource'>
): boolean {
  if (commercial.recouped !== true) return false;
  return commercial.isEstimate?.recouped === true || NOT_ANNOUNCED_RE.test(commercial.recoupedSource ?? '');
}

export interface RecoupmentAttribution {
  /** "Recouped, December 2014" (or "Recouped" when the date is unknown). */
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
export function getRecoupmentAttribution(commercial: ShowCommercial): RecoupmentAttribution {
  const date = formatRecoupedDate(commercial.recoupedDate);
  const headline = date ? `Recouped, ${date}` : 'Recouped';
  const sourceUrl = getCitedSourceUrl(commercial.sources);
  const notAnnounced = isUnannouncedRecoupment(commercial);
  const qualifier = notAnnounced ? NOT_ANNOUNCED_LABEL : null;

  let confidence: RecoupmentAttribution['confidence'];
  if (sourceUrl && !notAnnounced) {
    const basis = (commercial.sources ?? []).some((s) => s.type === 'sec' && s.url === sourceUrl)
      ? 'SEC filing'
      : 'Trade press report';
    confidence = { level: 'high', label: 'High confidence', basis };
  } else {
    confidence = {
      level: 'medium',
      label: 'Medium confidence',
      basis: qualifier ?? 'Industry reports, no linked source',
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
 * percent-of-capitalization is NOT an investor return (its denominator nets
 * out SVOG grants and adds a reserve, which put Chicago at ~958x), so there is
 * no modeled fallback.
 */
export function getReportedInvestorMultiple(
  commercial: Pick<ShowCommercial, 'investorMultiple' | 'sources'>
): number | null {
  const m = commercial.investorMultiple;
  if (typeof m !== 'number' || !isFinite(m) || m <= 0) return null;
  return getCitedSourceUrl(commercial.sources) ? m : null;
}

export interface DesignationDisplay {
  label: string;
  description: string;
  textClass: string;
  icon: string;
  isUndisclosed: boolean;
}

/**
 * What to call a designation on screen. A CLOSED show still stored as TBD
 * reads "Undisclosed: Closed; outcome not announced" instead of "TBD: still
 * running". Display only; commercial.json keeps TBD.
 */
export function getDesignationDisplay(
  designation: ShowCommercial['designation'],
  status: string | null | undefined
): DesignationDisplay {
  if (designation === 'TBD' && status === 'closed') {
    return {
      label: UNDISCLOSED_DESIGNATION.name,
      description: UNDISCLOSED_DESIGNATION.description,
      textClass: UNDISCLOSED_DESIGNATION.color,
      icon: UNDISCLOSED_DESIGNATION.icon,
      isUndisclosed: true,
    };
  }
  const style = getDesignationBadgeStyle(designation);
  return {
    label: designation,
    description: style.description,
    textClass: style.textClass,
    icon: style.icon,
    isUndisclosed: false,
  };
}

const PCT_CAP = 100;

function pctText(value: number): string {
  return value >= PCT_CAP ? '100%+' : `${value}%`;
}

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
}

/**
 * Labels for a modeled recoupment estimate. Above 100% the model only says
 * "past capitalization": its denominator is not what investors put in, so the
 * old "~Nx returned to investors" regime (Hamilton "~159x") is gone. Always
 * labelled as an estimate, with the range.
 */
export function getModelRecoupmentLabels(
  estimatedPct: [number, number] | [number, number, number]
): ModelRecoupmentLabels {
  const isModel = estimatedPct.length === 3;
  // Clamp at 0: the model can emit negative percentages for deep flops
  // (e.g. cabaret-2024 [-168, -120, -74]); "-120% recouped" is nonsense copy.
  const low = Math.max(0, Math.round(Math.min(...estimatedPct)));
  const high = Math.max(0, Math.round(Math.max(...estimatedPct)));
  const central = Math.max(0, isModel ? Math.round(estimatedPct[1]) : Math.round((low + high) / 2));
  const valueText = pctText(central);

  let label: string;
  if (isModel) {
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

  const ariaLabel = `Estimated ${valueText} recouped (range ${pctText(low)} to ${pctText(high)})`;
  return { low, central, high, valueText, label, rangeLabel, ariaLabel, barWidth: Math.min(central, PCT_CAP) };
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
