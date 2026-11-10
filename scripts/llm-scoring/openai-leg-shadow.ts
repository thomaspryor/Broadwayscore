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
 *   ... openai-leg-shadow.ts --report data/audit/openai-leg-ab --write=data/audit/openai-leg-ab-report.json
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

function loadMarkets(): Map<string, string> {
  const m = new Map<string, string>();
  try {
    const raw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    const shows = Array.isArray(raw) ? raw : raw.shows || [];
    for (const s of shows) m.set(s.id, String(s.market || s.category || 'unknown'));
  } catch { /* market 'unknown' */ }
  return m;
}

/** Past reviews the ensemble scored or rejected, keyed into market x outcome strata. */
function population(): Candidate[] {
  const markets = loadMarkets();
  const out: Candidate[] = [];
  for (const show of listShowDirs(REVIEW_TEXTS_DIR)) {
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
  };
}

async function runShard() {
  const shadowModel = flag('shadow-model', 'gpt-5.4-mini')!;
  if (!openaiScoringModels().includes(shadowModel)) throw new Error(`unknown --shadow-model ${shadowModel}`);
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
  if (fs.existsSync(outPath)) {
    for (const l of fs.readFileSync(outPath, 'utf8').split('\n')) { try { done.add(JSON.parse(l).id); } catch { /* partial line */ } }
  }

  const pop = population();
  const sample = stratifiedSample(pop, sampleN, seed);
  const mine = sample.filter((_, i) => i % shards === shard).filter((c) => !done.has(c.id)).slice(0, limit);
  console.log(`population ${pop.length}, sample ${sample.length}, shard ${shard}/${shards}: ${mine.length} to score (${done.size} already done), control ${SCORING_OPENAI} vs shadow ${shadowModel}`);

  const scorer = new EnsembleReviewScorer(
    process.env.ANTHROPIC_API_KEY || '', process.env.OPENAI_API_KEY || '', process.env.GEMINI_API_KEY, undefined,
    { verbose: false, shadowOpenaiModel: shadowModel as any },
  );

  let next = 0; let finished = 0;
  async function worker() {
    while (next < mine.length) {
      const c = mine[next++];
      let rec: any = { id: c.id, showId: c.showId, stratum: c.stratum, weight: c.weight, controlModel: SCORING_OPENAI, shadowModel };
      try {
        const reviewFile = JSON.parse(fs.readFileSync(c.filePath, 'utf8'));
        const prepared = scorer.prepareScoringInput(reviewFile);
        if (prepared.ok && prepared.prep?.band) rec.band = { floor: prepared.prep.band.floor, ceiling: prepared.prep.band.ceiling };
        const result = await scorer.scoreReviewFile(reviewFile);
        const e: any = result.ensembleResult;
        rec.control = e ? armOf(e) : { success: false, error: result.error || 'no_result' };
        rec.shadow = e && e.shadow ? armOf(e.shadow) : { success: false, error: 'no_shadow' };
      } catch (err: any) {
        rec.control = { success: false, error: String(err && err.message || err).slice(0, 200) };
        rec.shadow = { success: false, error: 'control_threw' };
      }
      fs.appendFileSync(outPath, JSON.stringify(rec) + '\n');
      finished++;
      if (finished % 25 === 0) console.log(`  ${finished}/${mine.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`shard ${shard} done: ${finished} records -> ${path.relative(ROOT, outPath)}`);
}

function runReport() {
  const dirArg = args[args.indexOf('--report') + 1];
  const dir = path.isAbsolute(dirArg) ? dirArg : path.join(ROOT, dirArg);
  const records: any[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { try { if (l.trim()) records.push(JSON.parse(l)); } catch { /* skip */ } }
  }
  // A resumed shard never re-scores a done id, so a duplicate means two runs
  // wrote the same review: keep the latest and say so.
  const byId = new Map<string, any>();
  let dupes = 0;
  for (const r of records) { if (byId.has(r.id)) dupes++; byId.set(r.id, r); }
  if (dupes) console.warn(`::warning::${dupes} duplicate review record(s) across shards; kept the latest of each`);
  const report = { generatedAt: new Date().toISOString(), ...computeReport([...byId.values()]) };
  const write = flag('write');
  if (write) fs.writeFileSync(path.isAbsolute(write) ? write : path.join(ROOT, write), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

if (args.includes('--report')) runReport();
else runShard().catch((e) => { console.error(e); process.exit(1); });
