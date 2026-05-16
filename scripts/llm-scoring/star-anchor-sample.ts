/**
 * Sprint 2: Star-anchored dry-run sample report
 *
 * Read-only sample selector + dry-run ensemble scorer + HTML report generator
 * for the V6 anchored-bands rollout (memory/sprint-plan-anchored-bands.md).
 *
 * READ-ONLY by construction: never writes to data/review-texts/*.json.
 * Inputs: data/review-texts/ (gitignored, read from main repo path)
 * Outputs: /tmp/star-anchor-sample-{files.txt, results.json, report-<ts>.html}
 *
 * Sub-commands:
 *   select  build /tmp/star-anchor-sample-files.txt (one per line)
 *   score   read files.txt, call ensemble with band, write results.json (checkpointed)
 *   report  read results.json, render report-<ts>.html
 *   run     select → score → report end-to-end
 *
 * Usage:
 *   node --import tsx scripts/llm-scoring/star-anchor-sample.ts <select|score|report|run> [opts]
 *   npx ts-node scripts/llm-scoring/star-anchor-sample.ts <select|score|report|run> [opts]
 *
 * Cost: ~$2-5 for 210 reviews via ensemble (Claude + OpenAI + Gemini).
 * Runtime: ~5-8 min sequential.
 */

import * as fs from 'fs';
import * as path from 'path';
import { starToBand, letterGradeToBand, buildSystemPromptV6, buildPromptV6, scoreToBucket, ScoreBand } from './config';

// ============================================================================
// Paths
// ============================================================================

const DATA_DIR = process.env.STAR_ANCHOR_DATA_DIR || '/Users/tompryor/Broadwayscore/data/review-texts';
// /tmp/ was wiped between sessions, losing the sample. Persist to claude-outputs
// (iCloud-synced) so multi-session runs survive. The HTML report contains
// 80-char excerpts of copyrighted prose — short-snippet/fair-use territory,
// and only the user's own iCloud sees them.
const OUTPUT_DIR = process.env.STAR_ANCHOR_OUTPUT_DIR || `${process.env.HOME}/Documents/claude-outputs/anchored-bands`;
const SAMPLE_FILES_PATH = `${OUTPUT_DIR}/sample-files.txt`;
const RESULTS_PATH = `${OUTPUT_DIR}/sample-results.json`;

// ============================================================================
// Types
// ============================================================================

interface ReviewSummary {
  path: string;
  showId: string;
  outletId: string;
  criticName: string | null;
  starRating: string | null;
  originalRating: string | null;
  aggregatorStars: string | null;
  aggregatorStarsSource: string | null;
  letterGrade: string | null;
  llmScore: number | null;
  originalScore: number | null;
  assignedScore: number | null;
  scoreSource: string | null;
  fullTextLen: number;
  publishDate: string | null;
  hasFlag: boolean;
}

interface SampleEntry extends ReviewSummary {
  category: string;
  expectedBand?: ScoreBand | null;
  starsRaw?: string | null;
  isLetterGrade: boolean;
  isPureLLM: boolean;
}

interface ScoredEntry extends SampleEntry {
  newScore: number | null;
  newBucket: string | null;
  newConfidence: string | null;
  newVerdict: string | null;
  keyQuote: string | null;
  reasoning: string | null;
  errorReason: string | null;
  prose80: string;
}

// ============================================================================
// Sample composition spec (210 target)
// ============================================================================

interface CategorySpec {
  key: string;
  label: string;
  n: number;
  pick: (r: ReviewSummary) => boolean;
}

const STAR_OUTLETS_FIVE = new Set(['timeout', 'timeout-london', 'guardian', 'telegraph']);
const AGGREGATOR_RELAYED = new Set(['london-box-office', 'westendtheatre', 'theatre-reviews', 'stagedoor']);

function ratingHas(r: ReviewSummary, ...needles: string[]): boolean {
  const fields = [r.starRating, r.originalRating, r.aggregatorStars].filter(Boolean) as string[];
  for (const f of fields) {
    const s = String(f);
    for (const n of needles) if (s.includes(n)) return true;
  }
  return false;
}

function isWrongProduction(r: any): boolean {
  return r.wrongShow || r.wrongProduction;
}

const CATEGORIES: CategorySpec[] = [
  {
    key: 'five-of-five',
    label: '5/5 from /5 outlets (Time Out, Guardian, Telegraph)',
    n: 30,
    pick: (r) =>
      STAR_OUTLETS_FIVE.has(r.outletId) && ratingHas(r, '5/5', '5 out of 5'),
  },
  {
    key: 'four-of-five',
    label: '4/5 from /5 outlets',
    n: 30,
    pick: (r) => STAR_OUTLETS_FIVE.has(r.outletId) && ratingHas(r, '4/5', '4 out of 5'),
  },
  {
    key: 'three-of-five',
    label: '3/5 from /5 outlets',
    n: 20,
    pick: (r) => STAR_OUTLETS_FIVE.has(r.outletId) && ratingHas(r, '3/5', '3 out of 5'),
  },
  {
    key: 'one-two-of-five',
    label: '1-2/5 from /5 outlets',
    n: 10,
    pick: (r) =>
      STAR_OUTLETS_FIVE.has(r.outletId) && (ratingHas(r, '1/5', '2/5')),
  },
  {
    key: 'usatoday-4-of-4',
    label: 'USA Today 4/4 (Gardner — 100% on /4)',
    n: 15,
    pick: (r) => r.outletId === 'usatoday' && ratingHas(r, '4/4'),
  },
  {
    key: 'usatoday-3-of-4',
    label: 'USA Today 3/4 (Gardner — 75% on /4)',
    n: 15,
    pick: (r) =>
      r.outletId === 'usatoday' && ratingHas(r, '3/4') && !ratingHas(r, '3.5/4'),
  },
  {
    key: 'nypost-of-4',
    label: 'NY Post /4 (Oleksinski)',
    n: 10,
    pick: (r) => r.outletId === 'nypost' && ratingHas(r, '/4'),
  },
  {
    key: 'usatoday-half-star-of-4',
    label: 'USA Today 3.5/4 (half-star on /4, Gardner — Dan\'s case)',
    n: 10,
    pick: (r) => r.outletId === 'usatoday' && ratingHas(r, '3.5/4'),
  },
  {
    key: 'amny-half-star-of-5',
    label: 'amNY 4.5/5 (half-star on /5)',
    n: 5,
    pick: (r) => r.outletId === 'amny' && ratingHas(r, '4.5/5', '3.5/5', '2.5/5'),
  },
  {
    key: 'aggregator-relayed',
    label: 'LBO/WET/TR/SD aggregator-relayed star (low reliability)',
    n: 10,
    pick: (r) => AGGREGATOR_RELAYED.has(r.outletId) && r.aggregatorStars !== null,
  },
  {
    key: 'pure-llm-rave',
    label: 'Pure-LLM raves currently scored 86-92 (no star/grade — Dan\'s ceiling complaint)',
    n: 50,
    pick: (r) =>
      r.starRating === null && r.originalRating === null && r.letterGrade === null &&
      r.llmScore !== null && r.llmScore >= 86 && r.llmScore <= 92,
  },
  {
    key: 'pure-llm-mid',
    label: 'Pure-LLM mid-range 70-80 (regression check — should not shift)',
    n: 10,
    pick: (r) =>
      r.starRating === null && r.originalRating === null && r.letterGrade === null &&
      r.llmScore !== null && r.llmScore >= 70 && r.llmScore <= 80,
  },
  {
    key: 'ew-letter-grade',
    label: 'EW letter grades (A+/A/A-/B+/B/B-)',
    n: 30,
    pick: (r) => r.outletId === 'ew' && r.letterGrade !== null,
  },
  {
    key: 'other-letter-grade',
    label: 'Other letter-grade outlets',
    n: 5,
    pick: (r) => r.outletId !== 'ew' && r.letterGrade !== null,
  },
];

// ============================================================================
// Load + filter
// ============================================================================

function summarizeReview(filePath: string): ReviewSummary | null {
  let d: any;
  try {
    d = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (isWrongProduction(d)) return null;
  const fullText = d.fullText || '';
  // Detect inline letter grade in originalRating field — score-extractors maps these.
  const rating = String(d.originalRating || '');
  const letterGrade = (() => {
    // Order matters: longer alternations FIRST so `A-` doesn't truncate to `A`.
    // `\b(A-?)\b` would match just `A` because `-?` is greedy with 0-char fallback
    // and the word boundary sits between A and -. Explicit ordering avoids that.
    const m = rating.match(/(A\+|A-|B\+|B-|C\+|C-|D\+|D-|A|B|C|D|F)(?:\b|$)/);
    return m ? m[1].toUpperCase() : null;
  })();
  return {
    path: filePath,
    showId: path.basename(path.dirname(filePath)),
    outletId: String(d.outletId || ''),
    criticName: d.criticName || null,
    starRating: d.starRating || null,
    originalRating: d.originalRating || null,
    aggregatorStars: d.aggregatorStars || null,
    aggregatorStarsSource: d.aggregatorStarsSource || null,
    letterGrade,
    llmScore: d.llmScore?.score ?? null,
    originalScore: typeof d.originalScore === 'number' ? d.originalScore : null,
    assignedScore: typeof d.assignedScore === 'number' ? d.assignedScore : null,
    scoreSource: d.scoreSource || null,
    fullTextLen: fullText.length,
    publishDate: d.publishDate || null,
    hasFlag: !!(d.wrongShow || d.wrongProduction || d.isRoundupArticle),
  };
}

function loadAllSummaries(): ReviewSummary[] {
  if (!fs.existsSync(DATA_DIR)) {
    throw new Error(`DATA_DIR not found: ${DATA_DIR}`);
  }
  const showDirs = fs
    .readdirSync(DATA_DIR)
    .filter((d) => !d.startsWith('.') && fs.statSync(path.join(DATA_DIR, d)).isDirectory());
  const out: ReviewSummary[] = [];
  for (const showDir of showDirs) {
    const dir = path.join(DATA_DIR, showDir);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      const s = summarizeReview(path.join(dir, f));
      // Need at least 600 chars of prose for a meaningful score
      if (s && s.fullTextLen >= 600) out.push(s);
    }
  }
  return out;
}

function shuffleInPlace<T>(arr: T[], seed = 1): T[] {
  // Mulberry32 RNG for deterministic sampling — same input always picks same files.
  let s = seed >>> 0;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function selectSample(all: ReviewSummary[]): SampleEntry[] {
  const used = new Set<string>();
  const sample: SampleEntry[] = [];
  console.log(`Selecting from ${all.length} candidate reviews...`);
  for (const cat of CATEGORIES) {
    const pool = shuffleInPlace(all.filter((r) => cat.pick(r) && !used.has(r.path)));
    const picked = pool.slice(0, cat.n);
    if (picked.length < cat.n) {
      console.log(`  ⚠ ${cat.key}: only ${picked.length}/${cat.n} matched`);
    } else {
      console.log(`  ✓ ${cat.key}: ${picked.length}/${cat.n}`);
    }
    for (const r of picked) {
      used.add(r.path);
      sample.push(buildSampleEntry(r, cat.key));
    }
  }
  return sample;
}

function buildSampleEntry(r: ReviewSummary, category: string): SampleEntry {
  // Determine the canonical raw rating string + band.
  const raw =
    r.starRating || r.originalRating || r.aggregatorStars || (r.letterGrade ? r.letterGrade : null);
  let band: ScoreBand | null = null;
  let isLetterGrade = false;
  if (r.letterGrade) {
    const lg = letterGradeToBand(r.letterGrade);
    if (lg) {
      band = { fraction: -1, floor: lg.floor, ceiling: lg.ceiling };
      isLetterGrade = true;
    }
  } else if (raw) {
    const m = String(raw).match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+)/);
    if (m) {
      const stars = parseFloat(m[1]);
      const max = parseFloat(m[2]);
      if (stars >= 0 && max > 0 && stars <= max) band = starToBand(stars, max);
    }
  }
  const isPureLLM = band === null && r.llmScore !== null;
  return { ...r, category, expectedBand: band, starsRaw: raw, isLetterGrade, isPureLLM };
}

// ============================================================================
// Mode: select
// ============================================================================

function runSelect(): void {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const all = loadAllSummaries();
  const sample = selectSample(all);
  fs.writeFileSync(
    SAMPLE_FILES_PATH,
    sample.map((s) => `${s.category}\t${s.path}`).join('\n') + '\n'
  );
  console.log(`\nWrote ${sample.length} entries to ${SAMPLE_FILES_PATH}`);
  // Also drop a JSON sidecar with the resolved bands/expected so score doesn't have to re-derive
  fs.writeFileSync(SAMPLE_FILES_PATH + '.json', JSON.stringify(sample, null, 2));
}

// ============================================================================
// Mode: score
// ============================================================================

async function runScore(): Promise<void> {
  // Parse optional --limit N for cheap smoke runs
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;

  // Load env from main repo if API keys missing
  if (!process.env.ANTHROPIC_API_KEY) loadEnvFromMain();

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  // Kimi (via OpenRouter) intentionally OFF for the dry-run sample. Empirically
  // it hangs or times out on pure-LLM-rave (unanchored) reviews — observed
  // 13/15 timeouts at 90s after Kimi was re-enabled when band=undefined.
  // 3-model ensemble (Claude + OpenAI + Gemini) is sufficient for the
  // dry-run signal we need from this 240-review sample.
  const openrouterKey = undefined;
  if (!claudeKey || !openaiKey) {
    throw new Error('ANTHROPIC_API_KEY and OPENAI_API_KEY required');
  }

  // Load sample
  if (!fs.existsSync(SAMPLE_FILES_PATH + '.json')) {
    throw new Error(`Run "select" first — missing ${SAMPLE_FILES_PATH}.json`);
  }
  const sample: SampleEntry[] = JSON.parse(fs.readFileSync(SAMPLE_FILES_PATH + '.json', 'utf8'));
  console.log(`Loaded ${sample.length} sample entries from ${SAMPLE_FILES_PATH}.json`);

  // Checkpoint resume
  let prior: ScoredEntry[] = [];
  if (fs.existsSync(RESULTS_PATH)) {
    try {
      prior = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
      console.log(`Resuming from checkpoint: ${prior.length} already scored`);
    } catch {
      prior = [];
    }
  }
  const doneSet = new Set(prior.map((r) => r.path));
  let remaining = sample.filter((s) => !doneSet.has(s.path));
  if (limit > 0) {
    remaining = remaining.slice(0, limit);
    console.log(`(--limit=${limit}) trimmed to ${remaining.length} for smoke run`);
  }
  console.log(`${remaining.length} to score`);

  // Build ensemble lazily (TS via require to share existing scorer)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EnsembleReviewScorer } = require('./ensemble-scorer');
  const ensemble = new EnsembleReviewScorer(claudeKey, openaiKey, geminiKey, openrouterKey, {
    verbose: false,
  });

  const results: ScoredEntry[] = [...prior];
  let processed = 0;
  let errors = 0;
  const startMs = Date.now();
  for (const entry of remaining) {
    processed++;
    const reviewJson = JSON.parse(fs.readFileSync(entry.path, 'utf8'));
    const reviewText = reviewJson.fullText || '';
    const prose80 = reviewText.slice(0, 80).replace(/\s+/g, ' ').trim();
    const context = `Show: ${reviewJson.showTitle || entry.showId}\nOutlet: ${entry.outletId}\nCritic: ${entry.criticName || 'Unknown'}${entry.starsRaw ? `\nOriginal Rating: ${entry.starsRaw}` : ''}`;

    try {
      const band = entry.expectedBand
        ? { floor: entry.expectedBand.floor, ceiling: entry.expectedBand.ceiling, fraction: entry.expectedBand.fraction }
        : undefined;
      const starsRaw = entry.starsRaw || undefined;
      // Per-review 90s timeout (defensive — observed one review hang for >14 min
      // during initial run, killed manually. Anthropic/OpenAI clients lack their
      // own request timeouts here; this prevents another stall.)
      const TIMEOUT_MS = 90_000;
      const result = await Promise.race([
        ensemble.scoreReview(reviewText, context, band, starsRaw),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`timeout:${TIMEOUT_MS}ms`)), TIMEOUT_MS)
        ),
      ]) as any;
      const scored: ScoredEntry = {
        ...entry,
        newScore: result.rejected ? null : (typeof result.score === 'number' ? result.score : null),
        newBucket: result.bucket || null,
        newConfidence: result.confidence || null,
        newVerdict: result.verdict || null,
        keyQuote: result.keyQuote || null,
        reasoning: result.reasoning || null,
        errorReason: result.rejected ? `rejected:${result.rejection || 'unknown'}` : null,
        prose80,
      };
      results.push(scored);
    } catch (e: any) {
      errors++;
      results.push({
        ...entry,
        newScore: null,
        newBucket: null,
        newConfidence: null,
        newVerdict: null,
        keyQuote: null,
        reasoning: null,
        errorReason: `error:${e.message || e}`,
        prose80,
      });
    }

    if (processed % 5 === 0) {
      fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
      const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(0);
      const avgSec = (elapsedSec as any) / processed;
      const remainMin = ((remaining.length - processed) * avgSec / 60).toFixed(1);
      console.log(`  [${processed}/${remaining.length}] elapsed=${elapsedSec}s, est-remaining=${remainMin}min, errors=${errors}`);
    }
  }

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  console.log(`\n✓ Wrote ${results.length} entries to ${RESULTS_PATH} (${errors} errors)`);
}

function loadEnvFromMain(): void {
  const envPath = '/Users/tompryor/Broadwayscore/.env';
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

// ============================================================================
// Mode: report
// ============================================================================

function pickBucketFromScore(s: number | null): string {
  if (s === null) return 'unknown';
  return scoreToBucket(s);
}

function runReport(): void {
  if (!fs.existsSync(RESULTS_PATH)) throw new Error(`Run "score" first — missing ${RESULTS_PATH}`);
  const results: ScoredEntry[] = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = `${OUTPUT_DIR}/sample-report-${ts}.html`;

  // Aggregates
  const histCur: Record<string, number> = {};
  const histNew: Record<string, number> = {};
  const buckets = ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan', 'unknown'];
  for (const b of buckets) {
    histCur[b] = 0;
    histNew[b] = 0;
  }
  let bucketShifts = 0;
  let coldRegressions = 0; // newScore < currentScore by >5
  const fiveStar: ScoredEntry[] = [];
  const pureLlmRaves: ScoredEntry[] = [];
  for (const r of results) {
    const cur = r.assignedScore ?? r.originalScore ?? r.llmScore;
    histCur[pickBucketFromScore(cur)] = (histCur[pickBucketFromScore(cur)] || 0) + 1;
    histNew[pickBucketFromScore(r.newScore)] = (histNew[pickBucketFromScore(r.newScore)] || 0) + 1;
    if (
      r.newScore !== null &&
      cur !== null &&
      pickBucketFromScore(cur) !== pickBucketFromScore(r.newScore)
    )
      bucketShifts++;
    if (r.newScore !== null && cur !== null && r.newScore < cur - 5) coldRegressions++;
    if (r.category === 'five-of-five' && r.newScore !== null) fiveStar.push(r);
    if (r.category === 'pure-llm-rave' && r.newScore !== null) pureLlmRaves.push(r);
  }

  const fiveScores = fiveStar.map((r) => r.newScore as number);
  const fiveMin = Math.min(...fiveScores);
  const fiveMax = Math.max(...fiveScores);
  const fiveMean = fiveScores.reduce((a, b) => a + b, 0) / fiveScores.length;
  const fiveStdev = Math.sqrt(
    fiveScores.reduce((s, x) => s + Math.pow(x - fiveMean, 2), 0) / fiveScores.length
  );
  // Distribution-shape acceptance: no more than 40% of 5★ scores within 2pts of any single value
  let worstClusterPct = 0;
  for (let v = 90; v <= 100; v++) {
    const inWindow = fiveScores.filter((s) => Math.abs(s - v) <= 2).length;
    const pct = (inWindow / fiveScores.length) * 100;
    if (pct > worstClusterPct) worstClusterPct = pct;
  }

  const pureLlmMax = pureLlmRaves.length ? Math.max(...pureLlmRaves.map((r) => r.newScore as number)) : null;
  const pureLlmCountAt95 = pureLlmRaves.filter((r) => (r.newScore as number) >= 95).length;

  // Acceptance gates
  const hits100 = fiveScores.includes(100);
  const hits91to93 = fiveScores.some((s) => s >= 91 && s <= 93);
  const stdevOk = fiveStdev >= 3;
  const distributionOk = worstClusterPct <= 40;
  const llmReach95 = (pureLlmMax || 0) >= 95;

  const html = `<!DOCTYPE html>
<html><head><title>Star-anchor sample report — ${ts}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 1600px; margin: 1em auto; padding: 1em; color: #222; }
h1 { font-size: 1.5em; margin-bottom: 0.25em; }
.subtitle { color: #666; margin-bottom: 1.5em; font-size: 0.9em; }
.gate { padding: 0.5em 1em; border-radius: 4px; margin: 0.25em 0; display: inline-block; margin-right: 0.5em; }
.gate.pass { background: #d4edda; color: #155724; }
.gate.fail { background: #f8d7da; color: #721c24; }
.section { margin-top: 2em; }
table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
th, td { padding: 0.4em 0.6em; text-align: left; border-bottom: 1px solid #eee; vertical-align: top; }
th { background: #f5f5f5; position: sticky; top: 0; }
tr:hover { background: #fafafa; }
.score-cell { font-weight: 600; text-align: center; }
.delta-pos { color: #155724; }
.delta-neg { color: #721c24; }
.flag { background: #fff3cd; color: #856404; padding: 0.1em 0.4em; border-radius: 3px; font-size: 0.75em; }
.cat { color: #666; font-size: 0.8em; }
.prose { font-style: italic; color: #555; max-width: 260px; word-break: break-word; }
.histo-bar { display: inline-block; height: 0.9em; vertical-align: middle; }
.cur { background: #aaa; }
.new { background: #4a90e2; }
.legend { font-size: 0.8em; color: #666; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1em; }
.stat-card { padding: 0.75em 1em; background: #f9f9f9; border-radius: 4px; }
.stat-label { font-size: 0.75em; color: #666; text-transform: uppercase; }
.stat-value { font-size: 1.5em; font-weight: 600; margin-top: 0.2em; }
</style></head><body>
<h1>Star-anchor sample report</h1>
<p class="subtitle">Sprint 2 dry-run · ${ts} · n=${results.length}</p>

<div class="section">
  <h2>Acceptance gates</h2>
  <span class="gate ${hits100 ? 'pass' : 'fail'}">5★ hits 100: ${hits100 ? '✓' : '✗'}</span>
  <span class="gate ${hits91to93 ? 'pass' : 'fail'}">5★ hits 91-93: ${hits91to93 ? '✓' : '✗'}</span>
  <span class="gate ${stdevOk ? 'pass' : 'fail'}">5★ stdev ≥3 (actual ${fiveStdev.toFixed(1)}): ${stdevOk ? '✓' : '✗'}</span>
  <span class="gate ${distributionOk ? 'pass' : 'fail'}">No ≥40% cluster within 2pts (worst ${worstClusterPct.toFixed(0)}%): ${distributionOk ? '✓' : '✗'}</span>
  <span class="gate ${llmReach95 ? 'pass' : 'fail'}">Pure-LLM raves ≥95 (max ${pureLlmMax}): ${llmReach95 ? '✓' : '✗'}</span>
</div>

<div class="section">
  <h2>5★ subset stats (n=${fiveStar.length})</h2>
  <div class="stat-grid">
    <div class="stat-card"><div class="stat-label">Min</div><div class="stat-value">${fiveMin}</div></div>
    <div class="stat-card"><div class="stat-label">Max</div><div class="stat-value">${fiveMax}</div></div>
    <div class="stat-card"><div class="stat-label">Mean</div><div class="stat-value">${fiveMean.toFixed(1)}</div></div>
    <div class="stat-card"><div class="stat-label">Stdev</div><div class="stat-value">${fiveStdev.toFixed(1)}</div></div>
    <div class="stat-card"><div class="stat-label">Hits 100</div><div class="stat-value">${fiveScores.filter(s => s === 100).length}</div></div>
    <div class="stat-card"><div class="stat-label">Hits 91-93</div><div class="stat-value">${fiveScores.filter(s => s >= 91 && s <= 93).length}</div></div>
  </div>
</div>

<div class="section">
  <h2>Pure-LLM rave stats (n=${pureLlmRaves.length})</h2>
  <div class="stat-grid">
    <div class="stat-card"><div class="stat-label">Max</div><div class="stat-value">${pureLlmMax}</div></div>
    <div class="stat-card"><div class="stat-label">Count ≥95</div><div class="stat-value">${pureLlmCountAt95}</div></div>
    <div class="stat-card"><div class="stat-label">% ≥95</div><div class="stat-value">${((pureLlmCountAt95 / Math.max(1, pureLlmRaves.length)) * 100).toFixed(0)}%</div></div>
  </div>
</div>

<div class="section">
  <h2>Bucket histogram (current vs new)</h2>
  <p class="legend"><span class="histo-bar cur" style="width:20px;"></span> current &nbsp;&nbsp; <span class="histo-bar new" style="width:20px;"></span> new</p>
  <table>
    <tr><th>Bucket</th><th>Current</th><th>New</th><th></th></tr>
    ${buckets
      .map(
        (b) => `<tr><td>${b}</td><td>${histCur[b]}</td><td>${histNew[b]}</td>
        <td>
          <div class="histo-bar cur" style="width:${(histCur[b] || 0) * 4}px"></div>
          <div class="histo-bar new" style="width:${(histNew[b] || 0) * 4}px"></div>
        </td></tr>`
      )
      .join('\n')}
  </table>
  <p>Bucket shifts: <strong>${bucketShifts}</strong> · Cold regressions (new < current by &gt;5pts): <strong>${coldRegressions}</strong></p>
</div>

<div class="section">
  <h2>All ${results.length} reviews</h2>
  <table>
    <tr>
      <th>Cat</th><th>Show</th><th>Outlet / Critic</th><th>Raw</th><th>Band</th>
      <th>Cur</th><th>New</th><th>Δ</th><th>Bucket</th><th>Conf</th><th>Prose (80 chars)</th><th>Reasoning</th><th>Flag</th>
    </tr>
    ${results
      .map((r) => {
        const cur = r.assignedScore ?? r.originalScore ?? r.llmScore;
        const delta = r.newScore !== null && cur !== null ? r.newScore - cur : null;
        const deltaClass =
          delta === null ? '' : delta > 5 ? 'delta-pos' : delta < -5 ? 'delta-neg' : '';
        const bandStr = r.expectedBand
          ? `[${r.expectedBand.floor},${r.expectedBand.ceiling}]`
          : (r.isPureLLM ? 'unanchored' : '—');
        const flag =
          r.errorReason
            ? `<span class="flag">${r.errorReason}</span>`
            : delta !== null && delta < -5
              ? '<span class="flag">cold</span>'
              : delta !== null && delta > 10
                ? '<span class="flag">hot</span>'
                : '';
        return `<tr>
          <td><span class="cat">${r.category}</span></td>
          <td>${r.showId}</td>
          <td>${r.outletId}<br><span class="cat">${r.criticName || ''}</span></td>
          <td>${r.starsRaw || ''}</td>
          <td>${bandStr}</td>
          <td class="score-cell">${cur ?? ''}</td>
          <td class="score-cell">${r.newScore ?? ''}</td>
          <td class="score-cell ${deltaClass}">${delta === null ? '' : (delta > 0 ? '+' + delta : delta)}</td>
          <td>${r.newBucket || ''}</td>
          <td>${r.newConfidence || ''}</td>
          <td class="prose">${escapeHtml(r.prose80)}</td>
          <td class="prose">${escapeHtml(r.reasoning || '')}</td>
          <td>${flag}</td>
        </tr>`;
      })
      .join('\n')}
  </table>
</div>
</body></html>`;

  fs.writeFileSync(reportPath, html);
  console.log(`\n✓ Wrote report to ${reportPath}`);
  console.log(`Acceptance gates: 100=${hits100} 91-93=${hits91to93} stdev=${stdevOk} distribution=${distributionOk} pure-LLM-95=${llmReach95}`);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'select') {
    runSelect();
  } else if (cmd === 'score') {
    await runScore();
  } else if (cmd === 'report') {
    runReport();
  } else if (cmd === 'run') {
    runSelect();
    await runScore();
    runReport();
  } else {
    console.error('Usage: star-anchor-sample.ts <select|score|report|run>');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
