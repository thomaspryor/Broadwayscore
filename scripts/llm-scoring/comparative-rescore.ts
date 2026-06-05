/**
 * Comparative within-band re-scoring pass.
 *
 * Runs AFTER per-review anchored-v6 scoring. For each show, it groups the
 * anchored-v6 reviews by star band and re-scores every group of 2+ reviews
 * TOGETHER, so genuine warmth differences spread instead of all collapsing to
 * the q3≈97 isolation anchor (see scripts/lib/comparative-band.js for the
 * validated rationale, 2026-06-05).
 *
 * Scope: anchored-v6 only ⇒ West End / Off-West-End only (those are the markets
 * in ANCHORED_MARKETS; Broadway has not been migrated). Singleton bands are
 * left untouched — there is nothing to compare against.
 *
 * Usage:
 *   tsx scripts/llm-scoring/comparative-rescore.ts --show=war-horse-west-end-2026 [--dry-run]
 *   tsx scripts/llm-scoring/comparative-rescore.ts --all-we [--limit=N] [--dry-run]
 *
 * Env: OPENAI_API_KEY, GEMINI_API_KEY (and optionally ANTHROPIC_API_KEY). At
 * least 2 models must be available or the run aborts (combine needs 2 to apply
 * the ordering guardrail). REVIEW_TEXTS_DIR overrides the data path.
 *
 * Rule 13 / §12.7: this is scoring logic. The --dry-run mode prints the
 * isolated→comparative delta, bucket drift, and mean drift so the A/B gate can
 * be checked before any write. All reviews must stay in the same bucket.
 */

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

const REVIEW_TEXTS_DIR =
  process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '../../data/review-texts');

// Human-review protection: never let an automated pass overwrite a human call.
const HUMAN_PROTECTION_FIELDS = [
  'humanReviewScore',
  'humanReviewedWrongProduction',
  'humanReviewedWrongShow',
  'manualScore',
];

type ReviewEntry = {
  file: string;
  filePath: string;
  data: any;
  band: ScoreBand;
  bandKey: string;
  starsRaw: string;
  text: string;
  isolated: number;
};

function isExcluded(data: any): boolean {
  if (!data) return true;
  if (data.wrongProduction || data.wrongShow || data.isRoundupArticle) return true;
  if (HUMAN_PROTECTION_FIELDS.some((f) => data[f] !== undefined && data[f] !== null && data[f] !== false)) {
    return true;
  }
  return false;
}

/** Load a show's anchored-v6 reviews, grouped by band. */
function loadGroups(showDir: string): Map<string, ReviewEntry[]> {
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

async function callOpenAI(prompt: string): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.3,
      }),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
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
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = res.content.find((c) => c.type === 'text');
    return block && block.type === 'text' ? block.text : null;
  } catch {
    return null;
  }
}

function availableModels(): Array<{ name: string; call: (p: string) => Promise<string | null> }> {
  const models: Array<{ name: string; call: (p: string) => Promise<string | null> }> = [];
  if (process.env.OPENAI_API_KEY) models.push({ name: 'openai', call: callOpenAI });
  if (process.env.GEMINI_API_KEY) models.push({ name: 'gemini', call: callGemini });
  if (process.env.ANTHROPIC_API_KEY) models.push({ name: 'claude', call: callClaude });
  return models;
}

type GroupResult = {
  bandKey: string;
  applied: Array<{ file: string; isolated: number; comparative: number; modelScores: Record<string, number>; warmthRank: number | null }>;
  agreement: number | null;
  skippedReason?: string;
};

async function rescoreGroup(
  entries: ReviewEntry[],
  models: ReturnType<typeof availableModels>,
): Promise<GroupResult | null> {
  if (entries.length < 2) return null;
  const band = entries[0].band;
  const prompt = buildComparativeBandPrompt(
    entries.map((e) => ({ id: e.file, outlet: e.data.outlet || e.data.outletId, text: e.text })),
    band,
    { starsRaw: entries[0].starsRaw, marketLabel: 'West End' },
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
    return { bandKey: entries[0].bandKey, applied: [], agreement: null, skippedReason: `only ${maps.length} model(s) returned parseable scores` };
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

function writeBack(entry: ReviewEntry, comparative: number, modelScores: Record<string, number>, agreement: number | null) {
  const data = entry.data;
  const isolated = entry.isolated;
  data.llmScore = data.llmScore || {};
  data.llmScore.score = comparative;
  data.assignedScore = comparative;
  data.llmScore.comparative = {
    isolatedScore: isolated,
    models: modelScores,
    agreement,
    groupBand: entry.bandKey,
    rescoredAt: new Date().toISOString(),
  };
  // bucket/thumb stay derived from score downstream; comparative never leaves band.
  fs.writeFileSync(entry.filePath, JSON.stringify(data, null, 2) + '\n');
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const allWE = args.includes('--all-we');
  const showArg = args.find((a) => a.startsWith('--show='))?.split('=')[1];
  const limit = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] || '0', 10);

  const models = availableModels();
  if (models.length < 2) {
    console.error(`✗ Need >=2 models; found ${models.length} (${models.map((m) => m.name).join(',') || 'none'}). Set OPENAI_API_KEY + GEMINI_API_KEY.`);
    process.exit(1);
  }
  console.log(`Models: ${models.map((m) => m.name).join(', ')}${dryRun ? '  [DRY RUN — no writes]' : ''}`);

  const showsArg = args.find((a) => a.startsWith('--shows='))?.split('=')[1];

  let shows: string[] = [];
  if (showArg) shows = [showArg];
  else if (showsArg) shows = showsArg.split(',').map((s) => s.trim()).filter(Boolean);
  else if (allWE) {
    shows = fs
      .readdirSync(REVIEW_TEXTS_DIR)
      .filter((s) => {
        try {
          return fs.statSync(path.join(REVIEW_TEXTS_DIR, s)).isDirectory() && /west-end|off-west-end/.test(s);
        } catch {
          return false;
        }
      });
    if (limit > 0) shows = shows.slice(0, limit);
  } else {
    console.error('Pass --show=ID or --all-we');
    process.exit(1);
  }

  // A/B accounting
  let totalReviews = 0, changed = 0, bucketShifts = 0;
  let sumDelta = 0, sumAbsDelta = 0;
  const examples: string[] = [];

  for (const show of shows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, show);
    const groups = loadGroups(showDir);
    for (const [bandKey, entries] of groups) {
      if (entries.length < 2) continue;
      const result = await rescoreGroup(entries, models);
      if (!result) continue;
      if (result.skippedReason) {
        console.log(`  ${show} [${bandKey}] skipped: ${result.skippedReason}`);
        continue;
      }
      const byFile = new Map(result.applied.map((a) => [a.file, a]));
      const lines: string[] = [];
      for (const e of entries) {
        totalReviews++;
        const a = byFile.get(e.file);
        if (!a) { lines.push(`    ${e.file}: ${e.isolated} → ${e.isolated} (kept)`); continue; }
        const delta = a.comparative - a.isolated;
        sumDelta += delta; sumAbsDelta += Math.abs(delta);
        if (a.comparative !== a.isolated) changed++;
        if (scoreToBucket(a.comparative) !== scoreToBucket(a.isolated)) bucketShifts++;
        lines.push(`    ${e.file}: ${a.isolated} → ${a.comparative}  (${Object.entries(a.modelScores).map(([n, s]) => `${n}:${s}`).join(' ')})`);
        if (!dryRun) writeBack(e, a.comparative, a.modelScores, result.agreement);
      }
      const header = `  ${show} [${bandKey}] n=${entries.length} agreement=${result.agreement?.toFixed(2) ?? 'n/a'}`;
      console.log(header);
      lines.forEach((l) => console.log(l));
      if (examples.length < 5) examples.push(header + '\n' + lines.join('\n'));
    }
  }

  console.log('\n===== A/B SUMMARY =====');
  console.log(`Reviews in multi-review bands: ${totalReviews}`);
  console.log(`Changed: ${changed}  (${totalReviews ? ((changed / totalReviews) * 100).toFixed(1) : '0'}%)`);
  console.log(`Bucket shifts: ${bucketShifts}  (${totalReviews ? ((bucketShifts / totalReviews) * 100).toFixed(1) : '0'}%)  [GATE: <5%]`);
  console.log(`Mean drift: ${totalReviews ? (sumDelta / totalReviews).toFixed(2) : '0'} pts  [GATE: <5pts]`);
  console.log(`Mean |drift|: ${totalReviews ? (sumAbsDelta / totalReviews).toFixed(2) : '0'} pts`);
  if (!dryRun) console.log(`\n✓ Wrote ${changed} updated review files.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
