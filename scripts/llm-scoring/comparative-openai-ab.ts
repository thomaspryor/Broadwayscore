/**
 * COMPARATIVE_OPENAI migration A/B (BRO-7341; OpenAI retires gpt-4o 2027-01-14). READ-ONLY: never writes a review file.
 *
 * The comparative within-band rescore (comparative-core.ts) re-scores a show's same-band reviews TOGETHER with the
 * OpenAI + Gemini (+ Claude) legs and combines them. This harness picks a seeded set of production-settled band groups,
 * calls Gemini ONCE per group (shared), then runs the PRODUCTION combine (rescoreGroup) with the OpenAI leg on the
 * control model, on the candidate, and on the control again (run-to-run noise floor). So each arm's final score differs
 * from the control's only in the OpenAI leg. Rule-13 gates: |mean drift| <= 5 pts, every bucket share shift <= 5pp.
 *
 *   npx ts-node --project scripts/tsconfig.json scripts/llm-scoring/comparative-openai-ab.ts \
 *     --groups=8 --candidate=gpt-5.6-luna [--control=gpt-4o] --out=data/audit/comparative-openai-ab-2026-11.json
 *
 * Env: OPENAI_API_KEY, GEMINI_API_KEY, REVIEW_TEXTS_DIR (default data/review-texts). ANTHROPIC_API_KEY is ignored on
 * purpose: holding the other legs to the one shared Gemini reply keeps the comparison to the OpenAI leg alone.
 */
import '../lib/llm-usage-install.js'; // LLM spend meter: keep it the first import (BRO-5043)
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { scoreToBucket } from './config';
import { availableModels, loadGroups, rescoreGroup, marketLabelForShow, ComparativeModel, ReviewEntry } from './comparative-core';

const { openaiChatBody } = require('../lib/llm-batch.js');
const { COMPARATIVE_PARAMS } = require('../lib/comparative-batch');
const { parseComparativeResponse } = require('../lib/comparative-band');
const { ratesFor } = require('../lib/research-cost');
const { COMPARATIVE_OPENAI } = require('../lib/models');

const BUCKETS = ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan'] as const;
const GATES = { meanDriftPts: 5, bucketShiftPp: 5 };

function arg(name: string, def: string): string {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? def;
}

const usage: Record<string, { input: number; output: number }> = {};

function openaiLeg(model: string, raw: Record<string, string>): ComparativeModel {
  return {
    name: 'openai',
    call: async (prompt: string) => {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        signal: AbortSignal.timeout(300000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify(openaiChatBody({
          model,
          messages: [{ role: 'user', content: prompt }],
          maxTokens: COMPARATIVE_PARAMS.maxTokens,
          temperature: COMPARATIVE_PARAMS.temperature,
        })),
      });
      if (!res.ok) { console.error(`  ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`); return null; }
      const j: any = await res.json();
      const u = (usage[model] = usage[model] || { input: 0, output: 0 });
      u.input += j.usage?.prompt_tokens || 0; u.output += j.usage?.completion_tokens || 0;
      const text = j.choices?.[0]?.message?.content ?? null;
      raw.text = text || '';
      return text;
    },
  };
}

/** Seeded pick of settled 3-4 review groups, stratified by band so every star level is in the sample. */
function pickGroups(dir: string, want: number, seed: string): Array<{ showId: string; bandKey: string; entries: ReviewEntry[] }> {
  const all: Array<{ showId: string; bandKey: string; entries: ReviewEntry[]; h: string }> = [];
  for (const showId of fs.readdirSync(dir)) {
    if (showId.startsWith('_') || showId.startsWith('.')) continue;
    const p = path.join(dir, showId);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const [bandKey, entries] of loadGroups(p)) {
      if (entries.length < 3 || entries.length > 4) continue;
      if (!entries.every((e) => e.data.llmScore?.comparative)) continue; // production-settled groups only
      if (entries.reduce((a, e) => a + e.text.length, 0) > 20000) continue; // keep the spend to cents
      all.push({ showId, bandKey, entries, h: crypto.createHash('sha1').update(seed + showId + bandKey).digest('hex') });
    }
  }
  const byBand = new Map<string, typeof all>();
  for (const g of all.sort((a, b) => a.h.localeCompare(b.h))) {
    if (!byBand.has(g.bandKey)) byBand.set(g.bandKey, []);
    byBand.get(g.bandKey)!.push(g);
  }
  const bands = ['31-50', '51-70', '71-90', '91-100'].filter((b) => byBand.has(b));
  const picked: typeof all = [];
  for (let i = 0; picked.length < want; i++) {
    const b = bands[i % bands.length];
    const g = byBand.get(b)!.shift();
    if (g) picked.push(g);
    if (bands.every((x) => byBand.get(x)!.length === 0)) break;
  }
  return picked;
}

function bucketShare(scores: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of BUCKETS) out[b] = scores.length ? (100 * scores.filter((s) => scoreToBucket(s) === b).length) / scores.length : 0;
  return out;
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** Arm vs control on the final (combined, bucket-clamped) score of every review in the sample. */
function compare(ctrl: number[], arm: number[], ctrlLeg: number[], armLeg: number[]) {
  const diffs = arm.map((s, i) => s - ctrl[i]);
  const legDiffs = armLeg.map((s, i) => Math.abs(s - ctrlLeg[i]));
  const cs = bucketShare(ctrl), as = bucketShare(arm);
  const shift: Record<string, number> = {};
  for (const b of BUCKETS) shift[b] = round(as[b] - cs[b]);
  const meanDrift = round(diffs.reduce((a, b) => a + b, 0) / (diffs.length || 1));
  const maxShift = Math.max(...Object.values(shift).map(Math.abs));
  return {
    n: diffs.length,
    meanDrift: { value: meanDrift, limit: GATES.meanDriftPts, pass: Math.abs(meanDrift) <= GATES.meanDriftPts },
    meanAbsDrift: round(diffs.reduce((a, b) => a + Math.abs(b), 0) / (diffs.length || 1)),
    maxAbsDrift: Math.max(0, ...diffs.map(Math.abs)),
    bucketShiftPp: { value: shift, limit: GATES.bucketShiftPp, pass: maxShift <= GATES.bucketShiftPp },
    openaiLegMeanAbsDiff: { value: round(legDiffs.reduce((a, b) => a + b, 0) / (legDiffs.length || 1)), n: legDiffs.length },
  };
}

async function main() {
  const control = arg('control', COMPARATIVE_OPENAI);
  const candidate = arg('candidate', 'gpt-5.6-luna');
  const want = parseInt(arg('groups', '8'), 10);
  const seed = arg('seed', '20261120');
  const out = arg('out', '');
  const dir = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '../../data/review-texts');
  const gemini = availableModels().find((m) => m.name === 'gemini');
  if (!process.env.OPENAI_API_KEY || !gemini) { console.error('Need OPENAI_API_KEY and GEMINI_API_KEY'); process.exit(1); }

  const groups = pickGroups(dir, want, seed);
  console.log(`Groups: ${groups.length}, reviews: ${groups.reduce((a, g) => a + g.entries.length, 0)}; control=${control} candidate=${candidate}`);
  const arms = { control, candidate, controlRerun: control } as const;
  const finals: Record<string, number[]> = { control: [], candidate: [], controlRerun: [] };
  const legs: Record<string, number[]> = { control: [], candidate: [], controlRerun: [] };
  const rows: any[] = [];
  let skippedGroups = 0;

  for (const g of groups) {
    const ids = g.entries.map((e) => e.file);
    let geminiReply: Promise<string | null> | null = null;
    const sharedGemini: ComparativeModel = { name: 'gemini', call: (p) => (geminiReply = geminiReply || gemini.call(p)) };
    const per: Record<string, { final: Record<string, number>; leg: Record<string, number>; skipped?: string }> = {};
    for (const [arm, model] of Object.entries(arms)) {
      const raw: Record<string, string> = {};
      const r = await rescoreGroup(g.entries, [openaiLeg(model, raw), sharedGemini], marketLabelForShow(g.showId));
      const applied = new Map((r?.applied || []).map((a) => [a.file, a.comparative]));
      const parsed = parseComparativeResponse(raw.text || '', ids);
      per[arm] = {
        final: Object.fromEntries(g.entries.map((e) => [e.file, applied.get(e.file) ?? e.isolated])),
        leg: Object.fromEntries(ids.filter((id) => parsed[id]).map((id) => [id, parsed[id].score])),
        skipped: r?.skippedReason,
      };
    }
    if (Object.values(per).some((p) => p.skipped)) {
      skippedGroups++;
      console.log(`  ${g.showId} [${g.bandKey}] skipped: ${Object.entries(per).map(([a, p]) => `${a}=${p.skipped || 'ok'}`).join(' ')}`);
      continue;
    }
    for (const e of g.entries) {
      for (const arm of Object.keys(arms)) finals[arm].push(per[arm].final[e.file]);
      const haveLeg = Object.keys(arms).every((a) => per[a].leg[e.file] != null);
      if (haveLeg) for (const arm of Object.keys(arms)) legs[arm].push(per[arm].leg[e.file]);
      rows.push({ showId: g.showId, band: g.bandKey, file: e.file, isolated: e.isolated, published: e.data.llmScore?.score,
        final: Object.fromEntries(Object.keys(arms).map((a) => [a, per[a].final[e.file]])),
        openaiLeg: Object.fromEntries(Object.keys(arms).map((a) => [a, per[a].leg[e.file] ?? null])) });
    }
    console.log(`  ${g.showId} [${g.bandKey}] ` + g.entries.map((e) => `${e.isolated}->${per.control.final[e.file]}/${per.candidate.final[e.file]}/${per.controlRerun.final[e.file]}`).join(' '));
  }

  const cost: Record<string, number> = {};
  for (const [m, u] of Object.entries(usage)) { const r = ratesFor(m); cost[m] = round((u.input * r.input + u.output * r.output) / 1e6, 4); }
  const candidateVsControl = compare(finals.control, finals.candidate, legs.control, legs.candidate);
  const noiseFloor = compare(finals.control, finals.controlRerun, legs.control, legs.controlRerun);
  const report = {
    generatedAt: new Date().toISOString(),
    card: 'BRO-7341',
    job: 'comparative within-band rescore (models.js COMPARATIVE_OPENAI)',
    control, candidate, seed,
    method: 'Seeded settled 3-4 review band groups, stratified by band. Gemini called once per group and shared; production rescoreGroup combine + bucket clamp; OpenAI leg on control, candidate and control again (noise floor). Claude leg omitted in every arm.',
    groups: groups.length, skippedGroups, reviews: finals.control.length,
    gates: GATES,
    candidateVsControl,
    noiseFloor,
    allPass: candidateVsControl.meanDrift.pass && candidateVsControl.bucketShiftPp.pass && skippedGroups === 0,
    usage, costUsd: cost,
    rows,
  };
  console.log(JSON.stringify({ ...report, rows: undefined }, null, 1));
  if (out) { fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(`wrote ${out}`); }
}

main().catch((e) => { console.error(e); process.exit(1); });
