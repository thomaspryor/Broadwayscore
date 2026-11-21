/**
 * OpenAI-leg migration A/B on PAST reviews (owner plan 2026-11-09; gpt-4o
 * retires 2027-01-14). READ-ONLY: never writes a review file.
 *
 * For a seeded, stratified sample of already-scored or ensemble-rejected
 * reviews, runs the PRODUCTION scorer (EnsembleReviewScorer.scoreReviewFile:
 * prepare, V5/V6 prompt, rejection consensus, band clamp, tail stretch) once
 * with the shadowOpenaiModel option. Claude and Gemini are scored fresh and
 * shared, so the shadow final differs from the control final ONLY in the
 * OpenAI leg. One JSONL record per review; resumable (done ids are skipped).
 * Gates and the report: scripts/lib/openai-leg-ab-metrics.js.
 *
 *   npx ts-node --project scripts/tsconfig.json scripts/llm-scoring/openai-leg-shadow.ts \
 *     --sample=1000 --seed=20261109 --shard=0 --shards=4 --concurrency=6 \
 *     --shadow-model=gpt-5.4-mini --out=data/audit/openai-leg-ab/shard-0.jsonl [--limit=20]
 *   ... --open-shows=25            every review of 25 open shows (per-show check)
 *   ... --shadow-model=gpt-4o      gpt-4o vs itself: the run-to-run noise floor
 *   ... openai-leg-shadow.ts --report data/audit/openai-leg-ab [--label=noise] --write=data/audit/openai-leg-ab-report.json
 */
import '../lib/llm-usage-install.js'; // LLM spend meter: keep it the first import (BRO-5043)
import * as fs from 'fs';
import * as path from 'path';
import { EnsembleReviewScorer } from './ensemble-scorer';

const { listShowDirs } = require('../lib/list-show-dirs');
const { isReviewTextFile } = require('../lib/review-text-sidecars');
const { openaiScoringModels } = require('../lib/llm-batch.js');
const { SCORING_OPENAI } = require('../lib/models');
const { computeReport } = require('../lib/openai-leg-ab-metrics.js');
const { parseMaxCost } = require('../lib/experiment-guard');

const ROOT = path.join(__dirname, '../..');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data/review-texts');
const SHOWS_PATH = path.join(ROOT, 'data/shows.json');

const args = process.argv.slice(2);
const flag = (name: string, dflt?: string) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};

/** Mulberry32: tiny seeded PRNG so every shard draws the identical sample. */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

interface Candidate { id: string; filePath: string; showId: string; stratum: string }

const OPEN_SHOWS = new Set<string>();

function loadMarkets(): Map<string, string> {
  const m = new Map<string, string>();
  try {
    const raw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    const shows = Array.isArray(raw) ? raw : raw.shows || [];
    // category separates Broadway / Off-Broadway / West End / Off-West End / regional;
    // market is the coarser city and only a fallback.
    for (const s of shows) {
      m.set(s.id, String(s.category || s.market || 'unknown'));
      if (s.status === 'open') OPEN_SHOWS.add(s.id);
    }
  } catch { /* market 'unknown' */ }
  return m;
}

/**
 * Per-show mode (--open-shows=N): EVERY scored/rejected review of N seeded-
 * random currently-open shows with >= 8 such reviews, weight 1. Answers "does
 * any show's headline critic score move?", which a corpus-wide sample cannot
 * (the 1,154-review run had only 2 shows with >= 5 sampled reviews).
 */
function openShowsSample(pop: Candidate[], n: number, seed: number): Array<Candidate & { weight: number }> {
  const rand = rng(seed);
  const byShow = new Map<string, Candidate[]>();
  for (const c of pop) if (OPEN_SHOWS.has(c.showId)) (byShow.get(c.showId) || byShow.set(c.showId, []).get(c.showId)!).push(c);
  const eligible = [...byShow.entries()].filter(([, v]) => v.length >= 8).map(([k]) => k).sort();
  const chosen = eligible.map((k) => ({ k, r: rand() })).sort((a, b) => a.r - b.r).slice(0, n).map((x) => x.k);
  console.log(`open shows with >= 8 scored reviews: ${eligible.length}; chosen ${chosen.length}: ${chosen.join(', ')}`);
  if (chosen.length === 0) throw new Error('--open-shows chose 0 shows (is data/shows.json present with status "open" shows?)');
  if (chosen.length < n) console.log(`::warning::asked for ${n} open shows, only ${chosen.length} qualify`);
  return chosen.flatMap((k) => byShow.get(k)!.map((c) => ({ ...c, weight: 1 }))).sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Past reviews the ensemble scored or rejected, keyed into market x outcome strata. */
function population(): Candidate[] {
  const markets = loadMarkets();
  const out: Candidate[] = [];
  for (const show of listShowDirs(REVIEW_TEXTS_DIR)) {
    // '_'-prefixed folders (e.g. _superseded-misattributed) hold quarantined
    // files, not live reviews: never part of the population (trial run 2026-11-10).
    if (show.startsWith('_') || show.startsWith('.')) continue;
    const dir = path.join(REVIEW_TEXTS_DIR, show);
    for (const f of fs.readdirSync(dir).filter(isReviewTextFile).sort()) {
      let d: any;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      const rejected = d.rejectedBy === 'ensemble-scoreability-check';
      const bucket = d.llmScore && d.llmScore.bucket;
      const ensembled = d.llmMetadata && String(d.llmMetadata.model || '').startsWith('ensemble:');
      if (!rejected && !(ensembled && bucket)) continue;
      const outcome = rejected ? 'rejected' : bucket;
      out.push({ id: `${show}/${f}`, filePath: path.join(dir, f), showId: show, stratum: `${markets.get(show) || 'unknown'}|${outcome}` });
    }
  }
  return out;
}

/** Proportional allocation with a floor of 15 per stratum; weight = population/sampled. */
function stratifiedSample(pop: Candidate[], n: number, seed: number): Array<Candidate & { weight: number }> {
  const rand = rng(seed);
  const byStratum = new Map<string, Candidate[]>();
  for (const c of pop) (byStratum.get(c.stratum) || byStratum.set(c.stratum, []).get(c.stratum)!).push(c);
  const picked: Array<Candidate & { weight: number }> = [];
  for (const [stratum, members] of [...byStratum.entries()].sort()) {
    const want = Math.min(members.length, Math.max(15, Math.round((n * members.length) / pop.length)));
    const shuffled = members.map((m) => ({ m, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.m);
    const take = shuffled.slice(0, want);
    for (const c of take) picked.push({ ...c, weight: members.length / take.length });
    void stratum;
  }
  return picked.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function armOf(e: any) {
  if (!e) return { success: false };
  // allModelsFailed carries a placeholder Mixed-50 (ensemble.ts): a failure, never a score.
  if (e.allModelsFailed) return { success: false, error: 'all_models_failed' };
  return {
    openaiLegOk: e.openaiLeg ? e.openaiLeg.ok : null,
    openaiLegRejected: e.openaiLeg ? e.openaiLeg.rejected : null,
    openaiLegError: e.openaiLeg ? e.openaiLeg.error || null : null,
    success: true,
    rejected: !!e.rejected,
    score: e.score,
    bucket: e.bucket,
    source: e.source,
    needsReview: !!e.needsReview,
    openaiScore: e.modelResults?.openai?.score ?? null,
    openaiBucket: e.modelResults?.openai?.bucket ?? null,
    claudeLegOk: e.claudeLeg ? e.claudeLeg.ok : null,
    claudeLegRejected: e.claudeLeg ? e.claudeLeg.rejected : null,
    claudeLegError: e.claudeLeg ? e.claudeLeg.error || null : null,
    claudeScore: e.modelResults?.claude?.score ?? null,
  };
}

// List prices, $ per 1M tokens: [input, output, cacheRead, cacheWrite].
// Sonnet 5.5 list likely $2/$10, but the cap table below prices it at the 4.6 rates (no repo price source). Sonnet 4.6 $3/$15, gpt-4o $2.50/$10, gpt-5.6-luna $0.20/$1.20,
// Gemini 2.5-flash $0.30/$2.50 (scripts/llm-scoring/cost.ts, scripts/lib/research-cost.js).
const CLAUDE_RATES: Record<string, number[]> = { 'claude-sonnet-4-6': [3, 15, 0.3, 3.75], 'claude-sonnet-5-5': [3, 15, 0.3, 3.75] /* cap prices 5.5 at 4.6 list rates (no repo price source); real bill is lower or equal */ };
const OPENAI_RATES_PM: Record<string, number[]> = { 'gpt-4o': [2.5, 10], 'gpt-5.6-luna': [0.2, 1.2], 'gpt-6-luna': [0.2, 1.2], 'gpt-5.4-mini': [0.75, 4.5], 'gpt-5.6-sol': [5, 30] };
const GEMINI_RATES = [0.3, 2.5];
function legCost(u: any, sh: any, shadowOpenai: string, shadowClaude?: string) {
  const claudeC = (t: any, m: string) => { const r = CLAUDE_RATES[m]; return t ? (t.input * r[0] + t.output * r[1] + (t.cacheRead || 0) * r[2] + (t.cacheWrite || 0) * r[3]) / 1e6 : 0; };
  const openaiC = (t: any, m: string) => { const r = OPENAI_RATES_PM[m] || [5, 30]; return t ? (t.input * r[0] + t.output * r[1]) / 1e6 : 0; };
  const out = {
    claudeControl: claudeC(u.claude, 'claude-sonnet-4-6'),
    openaiControl: openaiC(u.openai, SCORING_OPENAI), // the control leg runs the production pin (gpt-5.6-luna since BRO-7537)
    gemini: u.gemini ? (u.gemini.input * GEMINI_RATES[0] + u.gemini.output * GEMINI_RATES[1]) / 1e6 : 0,
    claudeShadow: shadowClaude ? claudeC(sh.claude, shadowClaude) : 0,
    openaiShadow: shadowOpenai !== 'none' ? openaiC(sh.openai, shadowOpenai) : 0,
  };
  const total = out.claudeControl + out.openaiControl + out.gemini + out.claudeShadow + out.openaiShadow;
  return { ...out, total, tokens: { claudeControl: u.claude, openaiControl: u.openai, gemini: u.gemini, claudeShadow: sh.claude, openaiShadow: sh.openai } };
}

async function runShard() {
  // --shadow-model=none runs a Claude-leg-only A/B (BRO-7529); --shadow-claude-model adds a Claude shadow arm.
  const shadowModel = flag('shadow-model', 'gpt-5.4-mini')!;
  // BRO-7524: the cap is always on (default $10 per shard); --max-cost is an alias; 0/junk/unlimited is refused.
  parseMaxCost(args.map((a) => (a.startsWith('--max-cost-usd=') ? a.replace('--max-cost-usd=', '--max-cost=') : a)), 10);
  if (shadowModel !== 'none' && !openaiScoringModels().includes(shadowModel)) throw new Error(`unknown --shadow-model ${shadowModel}`);
  const shadowClaudeModel = flag('shadow-claude-model');
  if (shadowClaudeModel && !['claude-sonnet-4-6', 'claude-sonnet-5-5'].includes(shadowClaudeModel)) throw new Error(`unknown --shadow-claude-model ${shadowClaudeModel}`);
  const sampleN = Number(flag('sample', '1000'));
  const seed = Number(flag('seed', '20261109'));
  const shard = Number(flag('shard', '0'));
  const shards = Number(flag('shards', '1'));
  const concurrency = Math.max(1, Number(flag('concurrency', '6')));
  const limit = flag('limit') ? Number(flag('limit')) : Infinity;
  if (Number.isFinite(limit)) console.log('::notice::--limit set: a smoke run. Stratum weights assume the full sample, so its report is NOT a verdict.');
  const out = flag('out', `data/audit/openai-leg-ab/shard-${shard}.jsonl`)!;
  const outPath = path.isAbsolute(out) ? out : path.join(ROOT, out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const done = new Set<string>();
  // done = every id any shard of this label already scored (dedupe shifts shard membership, so a
  // sibling shard's file can hold ids this shard would otherwise re-bill on resume).
  const prefix = path.basename(outPath).replace(/shard-\d+\.jsonl$/, '');
  for (const f of fs.readdirSync(path.dirname(outPath))) {
    if (!new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 'shard-\\d+\\.jsonl$').test(f)) continue;
    for (const l of fs.readFileSync(path.join(path.dirname(outPath), f), 'utf8').split('\n')) { try { done.add(JSON.parse(l).id); } catch { /* partial line */ } }
  }

  const pop = population();
  const openShowsRaw = flag('open-shows');
  const openShows = openShowsRaw ? Number(openShowsRaw) : 0;
  if (openShowsRaw && !(Number.isInteger(openShows) && openShows > 0)) throw new Error(`--open-shows must be a positive integer, got "${openShowsRaw}"`);
  const sample = openShows > 0 ? openShowsSample(pop, openShows, seed) : stratifiedSample(pop, sampleN, seed);
  // --shuffle: seeded shuffle before --limit, so a bounded run is a random slice, not the alphabetically first shows (BRO-7341).
  const ordered = !args.includes('--shuffle') ? sample
    : (() => { const r = rng(seed ^ 0x9e3779b9); return sample.map((c) => ({ c, k: r() })).sort((x, y) => x.k - y.k).map((x) => x.c); })();
  // Dedupe BEFORE sharding (BRO-7529): the prior shadow run billed 581 duplicate calls because the
  // sample holds syndicated copies of one review (same prepared input and band). Every shard computes
  // the same deduped list, so shards stay disjoint. Local only, no API call.
  const dedupeScorer = new EnsembleReviewScorer('', '', undefined, undefined, { verbose: false });
  const seenInput = new Set<string>();
  let dupDropped = 0;
  const deduped = ordered.filter((c) => {
    try {
      const prep = dedupeScorer.prepareScoringInput(JSON.parse(fs.readFileSync(c.filePath, 'utf8')));
      if (!prep.ok || !prep.prep) return true;
      const key = JSON.stringify([prep.prep.scoringInput, prep.prep.band || null]);
      if (seenInput.has(key)) { dupDropped++; return false; }
      seenInput.add(key);
    } catch { /* unreadable: keep it, the run records the error */ }
    return true;
  });
  if (dupDropped) console.log(`dedupe: dropped ${dupDropped} reviews whose prepared scoring input duplicates an earlier one`);
  const mine = deduped.filter((_, i) => i % shards === shard).filter((c) => !done.has(c.id)).slice(0, limit);
  console.log(`population ${pop.length}, sample ${sample.length}, shard ${shard}/${shards}: ${mine.length} to score (${done.size} already done), control ${SCORING_OPENAI} vs shadow ${shadowModel}${shadowClaudeModel ? `, claude shadow ${shadowClaudeModel}` : ''}`);

  const scorer = new EnsembleReviewScorer(
    process.env.ANTHROPIC_API_KEY || '', process.env.OPENAI_API_KEY || '', process.env.GEMINI_API_KEY, undefined,
    { verbose: false, shadowOpenaiModel: shadowModel === 'none' ? undefined : shadowModel as any, shadowClaudeModel: shadowClaudeModel as any },
  );

  // Spend guard (BRO-7529, owner cap): --max-cost-usd is THIS shard's budget, priced from the scorers'
  // own token counts at list rates (sync pricing, no batch discount, so an upper bound).
  const maxCost = parseMaxCost(args.map((a) => (a.startsWith('--max-cost-usd=') ? a.replace('--max-cost-usd=', '--max-cost=') : a)), 10);
  const spent = () => legCost(scorer.getTokenUsage(), scorer.getShadowTokenUsage(), shadowModel, shadowClaudeModel).total;
  const costPath = outPath.replace(/\.jsonl$/, '.cost.json');
  let priorSpend = 0;
  try { priorSpend = Number(JSON.parse(fs.readFileSync(costPath, 'utf8')).total) || 0; } catch { /* first run */ }
  if (priorSpend) console.log(`resuming: prior est spend $${priorSpend.toFixed(2)} counts toward --max-cost-usd`);
  const spentTotal = () => priorSpend + spent();
  const writeCost = () => {
    const c = legCost(scorer.getTokenUsage(), scorer.getShadowTokenUsage(), shadowModel, shadowClaudeModel);
    fs.writeFileSync(costPath, JSON.stringify({ records: finished, capHit, maxCostUsd: Number.isFinite(maxCost) ? maxCost : null, priorSpend, ...c, total: priorSpend + c.total }, null, 2) + '\n');
    return priorSpend + c.total;
  };
  let capHit = false;
  let next = 0; let finished = 0;
  async function worker() {
    while (next < mine.length) {
      if (spentTotal() >= maxCost) { capHit = true; break; }
      const c = mine[next++];
      let rec: any = { id: c.id, showId: c.showId, stratum: c.stratum, weight: c.weight, controlModel: SCORING_OPENAI, shadowModel, controlClaudeModel: 'claude-sonnet-4-6', shadowClaudeModel: shadowClaudeModel || null };
      try {
        const reviewFile = JSON.parse(fs.readFileSync(c.filePath, 'utf8'));
        const prepared = scorer.prepareScoringInput(reviewFile);
        if (prepared.ok && prepared.prep?.band) rec.band = { floor: prepared.prep.band.floor, ceiling: prepared.prep.band.ceiling };
        const result = await scorer.scoreReviewFile(reviewFile);
        const e: any = result.ensembleResult;
        rec.control = e ? armOf(e) : { success: false, error: result.error || 'no_result' };
        rec.shadow = shadowModel === 'none' ? undefined : (e && e.shadow ? armOf(e.shadow) : { success: false, error: 'no_shadow' });
        if (shadowClaudeModel) rec.shadowClaude = e && e.shadowClaude ? armOf(e.shadowClaude) : { success: false, error: 'no_shadow_claude' };
      } catch (err: any) {
        rec.control = { success: false, error: String(err && err.message || err).slice(0, 200) };
        if (shadowModel !== 'none') rec.shadow = { success: false, error: 'control_threw' };
      }
      fs.appendFileSync(outPath, JSON.stringify(rec) + '\n');
      finished++;
      if (finished % 25 === 0) console.log(`  ${finished}/${mine.length} est spend $${writeCost().toFixed(2)}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const totalSpend = writeCost();
  console.log(`shard ${shard} done: ${finished} records -> ${path.relative(ROOT, outPath)}; est spend $${totalSpend.toFixed(2)}${capHit ? ' (STOPPED at --max-cost-usd)' : ''}`);
}

function runReport() {
  const dirArg = args[args.indexOf('--report') + 1];
  const dir = path.isAbsolute(dirArg) ? dirArg : path.join(ROOT, dirArg);
  const records: any[] = [];
  // --label=X reads X-shard-*.jsonl only; no label reads the unlabelled shard-*.jsonl only, so runs never mix.
  const label = flag('label');
  const want = (x: string) => (label ? x.startsWith(`${label}-shard-`) : x.startsWith('shard-')) && x.endsWith('.jsonl');
  for (const f of fs.readdirSync(dir).filter(want)) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { try { if (l.trim()) records.push(JSON.parse(l)); } catch { /* skip */ } }
  }
  // A resumed shard never re-scores a done id, so a duplicate means two runs
  // wrote the same review: keep the latest and say so.
  const byId = new Map<string, any>();
  let dupes = 0;
  for (const r of records) { if (byId.has(r.id)) dupes++; byId.set(r.id, r); }
  if (dupes) console.warn(`::warning::${dupes} duplicate review record(s) across shards; kept the latest of each`);
  // --leg=claude: compare control vs the shadowClaude arm (BRO-7529); default compares the OpenAI shadow arm.
  const leg = flag('leg');
  const recs = [...byId.values()].map((r: any) => (leg === 'claude' ? { ...r, shadow: r.shadowClaude } : r));
  const report = { generatedAt: new Date().toISOString(), leg: leg || 'openai', ...computeReport(recs, { leg }) };
  const write = flag('write');
  if (write) fs.writeFileSync(path.isAbsolute(write) ? write : path.join(ROOT, write), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

if (args.includes('--report')) runReport();
else runShard().catch((e) => { console.error(e); process.exit(1); });
