/**
 * Comparative within-band re-scoring: the shared core (BRO-7283).
 *
 * One implementation of "re-score a show's same-band anchored-v6 reviews together", used by BOTH callers:
 *   - scripts/llm-scoring/comparative-rescore.ts (the cron / manual pass), and
 *   - the opening-night lane (scripts/opening-night-lane.js builds a settle port from settleShow), so the score the
 *     lane publishes is the score this pass would settle on, and the next cron run finds every group settled and
 *     leaves it alone (isGroupSettled). Before this, the lane published the isolated scores and the cron moved them
 *     hours later (Blueberries 80.62 -> 79.97 after the owner posted it).
 * Nothing here reads env for paths, writes through anything but the injected `writeFile`, or prints; the callers own
 * that.
 */
import '../lib/llm-usage-install.js'; // LLM spend meter: first import, so the lane (which loads this) meters its calls too (BRO-5043)
import * as fs from 'fs';
import * as path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildComparativeBandPrompt,
  parseComparativeResponse,
  combineComparative,
  scoreToBucket,
  clampScoreToBucket,
  ScoreBand,
} from './config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { detectBandFromReviewFile } = require('../lib/star-reliability');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getBestTextForScoring } = require('../lib/text-quality');
const { openaiChatBody } = require('../lib/llm-batch.js');
const { COMPARATIVE_OPENAI } = require('../lib/models');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  isGroupSettled,
  buildComparativeMarker,
  bumpComparativeFailure,
  recordedIsolatedScore,
  MAX_COMPARATIVE_FAILURES,
} = require('../lib/comparative-band');

// Human-review protection: never let an automated pass overwrite a human call.
const HUMAN_PROTECTION_FIELDS = [
  'humanReviewScore',
  'humanReviewedWrongProduction',
  'humanReviewedWrongShow',
  'manualScore',
];

export type ReviewEntry = {
  file: string;
  filePath: string;
  data: any;
  band: ScoreBand;
  bandKey: string;
  starsRaw: string;
  text: string;
  isolated: number;
};

export function isExcluded(data: any): boolean {
  if (!data) return true;
  if (data.wrongProduction || data.wrongShow || data.isRoundupArticle) return true;
  // push-review-texts restores every protected field (llmScore included) on a
  // _locked file, so neither a new score nor the comparative marker would ever
  // persist — the group would be re-sent every run (BRO-4467).
  if (data._locked === true) return true;
  if (HUMAN_PROTECTION_FIELDS.some((f) => data[f] !== undefined && data[f] !== null && data[f] !== false)) {
    return true;
  }
  return false;
}

/** Load a show's anchored-v6 reviews, grouped by band. */
export function loadGroups(showDir: string): Map<string, ReviewEntry[]> {
  const groups = new Map<string, ReviewEntry[]>();
  let files: string[];
  try {
    files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json'));
  } catch {
    return groups;
  }
  for (const file of files) {
    const filePath = path.join(showDir, file);
    let data: any;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    if (data.scoreSource !== 'anchored-v6') continue;
    if (isExcluded(data)) continue;
    const score = data.llmScore?.score;
    const band = data.llmScore?.band;
    if (typeof score !== 'number' || !band || typeof band.floor !== 'number') continue;

    // Re-detect to recover the raw rating string for the prompt; fall back to
    // the stored band if detection is unavailable.
    const detection = detectBandFromReviewFile(data);
    const starsRaw = detection?.starsRaw || `${band.floor}-${band.ceiling}`;

    const sel = getBestTextForScoring(data);
    const text = sel?.text || data.fullText || data.excerpt || '';
    if (!text || text.length < 120) continue; // too little prose to compare warmth

    const bandKey = `${band.floor}-${band.ceiling}`;
    const entry: ReviewEntry = {
      file,
      filePath,
      data,
      band: { floor: band.floor, ceiling: band.ceiling, fraction: band.fraction ?? -1 },
      bandKey,
      starsRaw,
      text,
      isolated: score,
    };
    if (!groups.has(bandKey)) groups.set(bandKey, []);
    groups.get(bandKey)!.push(entry);
  }
  return groups;
}

// ---- Model callers (comparative array output) -------------------------------

// BRO-3392 — cumulative token usage across this process's model calls, so a
// run-end costUsd can be computed via cost.ts's costBreakdown() the same way
// index.ts's ensemble path does (BRO-3381). Mutated directly inside
// callOpenAI/callGemini/callClaude, mirroring their existing module-level
// client-caching pattern below.
export const usageTotals = {
  claude: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  openai: { input: 0, output: 0 },
  gemini: { input: 0, output: 0 },
};

async function callOpenAI(prompt: string): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      signal: AbortSignal.timeout(300000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      // COMPARATIVE_OPENAI, not SCORING_OPENAI: this job rewrites already-
      // published scores, so it moves to a new model only after its own check
      // (owner plan 2026-11-09). Body via the shared builder (llm-batch.js).
      body: JSON.stringify(openaiChatBody({
        model: COMPARATIVE_OPENAI,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 2000,
        temperature: 0.3,
      })),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    if (j.usage) {
      usageTotals.openai.input += j.usage.prompt_tokens || 0;
      usageTotals.openai.output += j.usage.completion_tokens || 0;
    }
    return j.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

let geminiClient: GoogleGenerativeAI | null = null;
async function callGemini(prompt: string): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    geminiClient = geminiClient || new GoogleGenerativeAI(key);
    const model = geminiClient.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 2000,
        thinkingConfig: { thinkingBudget: 0 },
      } as any,
    });
    const result = await model.generateContent(prompt);
    const usage = result.response.usageMetadata;
    if (usage) {
      usageTotals.gemini.input += usage.promptTokenCount || 0;
      usageTotals.gemini.output += usage.candidatesTokenCount || 0;
    }
    return result.response.text() || null;
  } catch {
    return null;
  }
}

let anthropicClient: Anthropic | null = null;
async function callClaude(prompt: string): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    anthropicClient = anthropicClient || new Anthropic({ apiKey: key });
    const res = await anthropicClient.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    });
    if (res.usage) {
      usageTotals.claude.input += res.usage.input_tokens || 0;
      usageTotals.claude.output += res.usage.output_tokens || 0;
      usageTotals.claude.cacheRead += res.usage.cache_read_input_tokens || 0;
      usageTotals.claude.cacheWrite += res.usage.cache_creation_input_tokens || 0;
    }
    const block = res.content.find((c) => c.type === 'text');
    return block && block.type === 'text' ? block.text : null;
  } catch {
    return null;
  }
}

export type ComparativeModel = { name: string; call: (p: string) => Promise<string | null> };

export function availableModels(): ComparativeModel[] {
  const models: ComparativeModel[] = [];
  if (process.env.OPENAI_API_KEY) models.push({ name: 'openai', call: callOpenAI });
  if (process.env.GEMINI_API_KEY) models.push({ name: 'gemini', call: callGemini });
  if (process.env.ANTHROPIC_API_KEY) models.push({ name: 'claude', call: callClaude });
  return models;
}

export type GroupResult = {
  bandKey: string;
  applied: Array<{ file: string; isolated: number; comparative: number; modelScores: Record<string, number>; warmthRank: number | null }>;
  agreement: number | null;
  skippedReason?: string;
  /** Fewer than 2 models answered at all (outage): not counted as a failed attempt. */
  transient?: boolean;
};

export async function rescoreGroup(
  entries: ReviewEntry[],
  models: ComparativeModel[],
  marketLabel: string = 'West End',
): Promise<GroupResult | null> {
  if (entries.length < 2) return null;
  const band = entries[0].band;
  const prompt = buildComparativeBandPrompt(
    entries.map((e) => ({ id: e.file, outlet: e.data.outlet || e.data.outletId, text: e.text })),
    band,
    { starsRaw: entries[0].starsRaw, marketLabel },
  );
  const ids = entries.map((e) => e.file);

  const perModelMaps: Record<string, Record<string, number>> = {};
  const raw = await Promise.all(models.map((m) => m.call(prompt)));
  models.forEach((m, i) => {
    const parsed = parseComparativeResponse(raw[i] || '', ids);
    const map: Record<string, number> = {};
    for (const id of ids) if (parsed[id]) map[id] = parsed[id].score;
    if (Object.keys(map).length) perModelMaps[m.name] = map;
  });

  const maps = Object.values(perModelMaps);
  if (maps.length < 2) {
    // The callers return null on any HTTP/network error. If fewer than 2
    // models even answered, this is an outage, not a bad group: don't count it
    // toward the give-up cap, or a 30-minute provider outage would freeze
    // every group it touched (BRO-4467).
    const answered = raw.filter((r) => typeof r === 'string' && r.trim()).length;
    return {
      bandKey: entries[0].bandKey,
      applied: [],
      agreement: null,
      skippedReason: `only ${maps.length} model(s) returned parseable scores (${answered} answered)`,
      transient: answered < 2,
    };
  }

  const isolated: Record<string, number> = {};
  for (const e of entries) isolated[e.file] = e.isolated;
  const combined = combineComparative(maps, isolated, band);

  const applied: GroupResult['applied'] = [];
  let agreement: number | null = null;
  for (const e of entries) {
    const c = combined[e.file];
    agreement = c.agreement;
    if (!c.applied) continue;
    // Bucket-preserving clamp: comparative repositions WITHIN the bucket the
    // isolated score already landed in. The 5★ band [91,100] is entirely
    // inside Rave so this is a no-op there; for the 4★ band [71,90], which
    // straddles Positive [70,82] / Rave [83,90], it stops a warmth nudge from
    // silently flipping a review's bucket. Guarantees the §13 A/B bucket-shift
    // gate is 0% — comparative only spreads WITHIN a bucket, never across it.
    const comparative = clampScoreToBucket(c.score, scoreToBucket(e.isolated));
    if (comparative === e.isolated) continue; // clamp erased the change
    const modelScores: Record<string, number> = {};
    for (const [name, map] of Object.entries(perModelMaps)) if (map[e.file] != null) modelScores[name] = map[e.file];
    applied.push({ file: e.file, isolated: e.isolated, comparative, modelScores, warmthRank: null });
  }
  return { bandKey: entries[0].bandKey, applied, agreement };
}

export type WriteFile = (filePath: string, data: any) => void;
const defaultWriteFile: WriteFile = (filePath, data) => fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');

function writeBack(entry: ReviewEntry, comparative: number, modelScores: Record<string, number>, agreement: number | null, writeFile: WriteFile) {
  const data = entry.data;
  const isolated = entry.isolated;
  data.llmScore = data.llmScore || {};
  data.llmScore.score = comparative;
  data.assignedScore = comparative;
  data.llmScore.comparative = buildComparativeMarker({
    isolatedScore: recordedIsolatedScore(data, isolated),
    models: modelScores,
    agreement,
    groupBand: entry.bandKey,
  });
  // bucket/thumb stay derived from score downstream; comparative never leaves band.
  writeFile(entry.filePath, data);
}

/**
 * BRO-4467: record that this review was compared and kept its score, so the
 * group counts as settled (isGroupSettled) and the next cron run skips it.
 * Score fields are untouched.
 */
function markKept(entry: ReviewEntry, agreement: number | null, writeFile: WriteFile) {
  const data = entry.data;
  data.llmScore = data.llmScore || {};
  data.llmScore.comparative = buildComparativeMarker({
    isolatedScore: recordedIsolatedScore(data, entry.isolated),
    agreement,
    groupBand: entry.bandKey,
    kept: true,
  });
  writeFile(entry.filePath, data);
}

/**
 * BRO-4467: count a paid-for attempt whose model replies didn't parse. After
 * MAX_COMPARATIVE_FAILURES the group is treated as settled (isGroupSettled).
 */
function markFailedAttempt(entry: ReviewEntry, reason: string, writeFile: WriteFile) {
  const data = entry.data;
  data.llmScore = data.llmScore || {};
  data.llmScore.comparativeFailures = bumpComparativeFailure(data.llmScore.comparativeFailures, reason);
  writeFile(entry.filePath, data);
}

/**
 * The prompt's market wording. The pass was written for the West End and hard-coded it, so a per-show run on a Broadway
 * show asked the models to compare "West End" reviews. Both callers now take it from the show id.
 */
export function marketLabelForShow(showId: string): string {
  if (/west-end/.test(showId)) return 'West End';
  if (/off-broadway/.test(showId)) return 'Off-Broadway';
  return 'Broadway';
}

export type SettleStats = {
  totalReviews: number;
  changed: number;
  bucketShifts: number;
  sumDelta: number;
  sumAbsDelta: number;
  /** API-calling groups this call (kept or failed groups count: the models were paid for). */
  rescoresDone: number;
  capReached: boolean;
  /** Files whose score moved, with the score they carried before. */
  changedFiles: Array<{ file: string; filePath: string; from: number; to: number }>;
  /** Groups that could not be settled this call (outage / unparseable): their isolated scores stay. */
  unsettled: Array<{ bandKey: string; reason: string; transient: boolean }>;
  examples: string[];
};

export type SettleOptions = {
  reviewTextsDir: string;
  models: ComparativeModel[];
  dryRun?: boolean;
  /** Cap on API-calling groups in this call (0 = no cap). */
  maxRescores?: number;
  /** Only the band group(s) holding this file (the lane settles the group a new review just joined). */
  onlyFile?: string;
  writeFile?: WriteFile;
  log?: (line: string) => void;
};

/**
 * Settle one show: re-score each unsettled same-band group of 2+ anchored-v6 reviews together, write the new scores and
 * the `llmScore.comparative` markers, and report what moved. Idempotent (isGroupSettled), so a second call costs nothing.
 */
export async function settleShow(showId: string, opts: SettleOptions): Promise<SettleStats> {
  const { reviewTextsDir, models, dryRun = false, maxRescores = 0, onlyFile, writeFile = defaultWriteFile, log = () => {} } = opts;
  const stats: SettleStats = {
    totalReviews: 0, changed: 0, bucketShifts: 0, sumDelta: 0, sumAbsDelta: 0,
    rescoresDone: 0, capReached: false, changedFiles: [], unsettled: [], examples: [],
  };
  const marketLabel = marketLabelForShow(showId);
  const groups = loadGroups(path.join(reviewTextsDir, showId));
  for (const [bandKey, entries] of groups) {
    if (entries.length < 2) continue;
    if (onlyFile && !entries.some((e) => e.file === onlyFile)) continue;
    // Nothing new to compare once every entry in this show+band already carries a comparative verdict. Zero API cost.
    if (isGroupSettled(entries)) continue;
    if (maxRescores > 0 && stats.rescoresDone >= maxRescores) {
      stats.capReached = true;
      log(`\nReached --max-rescores=${maxRescores}; stopping.`);
      break;
    }
    const result = await rescoreGroup(entries, models, marketLabel);
    if (!result) continue;
    // The models were paid for whether or not their replies parsed, so a failed group counts toward the cap (BRO-4467).
    stats.rescoresDone++;
    if (result.skippedReason) {
      log(`  ${showId} [${bandKey}] skipped: ${result.skippedReason}`);
      stats.unsettled.push({ bandKey, reason: result.skippedReason, transient: !!result.transient });
      if (!dryRun && !result.transient) {
        for (const e of entries) markFailedAttempt(e, result.skippedReason, writeFile);
        if (isGroupSettled(entries)) {
          console.warn(`  ⚠️ ${showId} [${bandKey}] giving up after ${MAX_COMPARATIVE_FAILURES} unparseable attempts; isolated scores stay`);
        }
      }
      continue;
    }
    const byFile = new Map(result.applied.map((a) => [a.file, a]));
    const lines: string[] = [];
    for (const e of entries) {
      stats.totalReviews++;
      const a = byFile.get(e.file);
      if (!a) {
        lines.push(`    ${e.file}: ${e.isolated} → ${e.isolated} (kept)`);
        if (!dryRun) markKept(e, result.agreement, writeFile);
        continue;
      }
      const delta = a.comparative - a.isolated;
      stats.sumDelta += delta; stats.sumAbsDelta += Math.abs(delta);
      if (a.comparative !== a.isolated) {
        stats.changed++;
        stats.changedFiles.push({ file: e.file, filePath: e.filePath, from: a.isolated, to: a.comparative });
      }
      if (scoreToBucket(a.comparative) !== scoreToBucket(a.isolated)) stats.bucketShifts++;
      lines.push(`    ${e.file}: ${a.isolated} → ${a.comparative}  (${Object.entries(a.modelScores).map(([n, s]) => `${n}:${s}`).join(' ')})`);
      if (!dryRun) writeBack(e, a.comparative, a.modelScores, result.agreement, writeFile);
    }
    const header = `  ${showId} [${bandKey}] n=${entries.length} agreement=${result.agreement?.toFixed(2) ?? 'n/a'}`;
    log(header);
    lines.forEach((l) => log(l));
    if (stats.examples.length < 5) stats.examples.push(header + '\n' + lines.join('\n'));
  }
  return stats;
}
