#!/usr/bin/env node
// BRO-7839: measure the skeptic review on REAL past sessions where the owner had to ask "is this fully tested?".
// Each case file (JSON) holds what the session had done BEFORE the owner asked: its closing claim, the commands it ran
// (with ok/fail and an output tail), the files it changed and the commits it had landed, plus the gaps it admitted
// AFTER the question. The same reviewer the Stop gate uses (callReviewer + the same prompt) reads the before-state
// (real diffs from git for the landed commits), then a judge model marks which admitted gaps the reviewer named up
// front. Hit rate = admitted gaps the reviewer caught / admitted gaps.
//
//   node scripts/lib/skeptic-review-replay.mjs <case.json ...> [--json] [--model=<openai id>]
// Spends one reviewer call and one judge call per case (cents). Needs OPENAI_API_KEY.
import './llm-usage-install.js'; // LLM spend meter: keep it the first import (BRO-5043)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callReviewer, redact, REVIEW_MODEL, meterToSessionLedger } from './skeptic-review-stop.mjs';
import { isMainModule } from './is-main-module.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIFF_CAP = 14000;

/** Real diff hunks for the commits a session had landed (code files only), newest last, capped like the gate. */
export function diffEdits(commits, cwd = ROOT) {
  const out = [];
  for (const c of commits || []) {
    let d = '';
    try { d = execFileSync('git', ['show', '--format=', '--unified=2', c, '--', 'src', 'scripts', '.github', '.claude/hooks', '.claude/commands', 'supabase', 'tests'], { cwd, encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { continue; }
    for (const file of d.split(/^diff --git /m).filter(Boolean)) out.push(`DIFF ${file.slice(0, 2400)}`);
  }
  const kept = [];
  let budget = DIFF_CAP;
  for (let k = out.length - 1; k >= 0 && budget > 0; k--) { kept.unshift(out[k]); budget -= out[k].length; }
  return { edits: kept.map(redact), omitted: out.length - kept.length };
}

/** PURE-ish. Case file -> the reviewer input shape buildReviewInput produces. */
export function caseToInput(c, cwd = ROOT) {
  const { edits, omitted } = diffEdits(c.landed_commits, cwd);
  return {
    files: c.files_changed || [],
    edits,
    omittedEdits: omitted,
    commands: (c.commands_before_question || []).map((x) => ({ cmd: redact(x.cmd), ok: x.ok, tail: redact(x.tail || '') })),
    omittedCommands: 0,
    notes: '',
    claim: redact(c.claim_before_question || ''),
    previousGaps: [],
  };
}

const JUDGE = [
  'You compare two lists about the same software change.',
  'ADMITTED: problems the engineer admitted (untested or broken) after the project owner asked "is this fully tested?".',
  'REVIEWER: gaps an independent reviewer listed BEFORE the owner asked.',
  'For each ADMITTED item decide if some REVIEWER gap would have led the engineer to the same problem (same component and same kind of missing check; a broader gap that clearly covers it counts; a merely related topic does not).',
  'For each REVIEWER gap decide if it is plausible and specific to this change (not generic boilerplate).',
  'Reply JSON only: {"admitted":[{"i":<1-based>,"caught_by":<reviewer 1-based index or 0>,"note":"<short>"}],"reviewer":[{"i":<1-based>,"specific":true|false}]}',
].join('\n');

async function judge(admitted, gaps, env) {
  const user = `ADMITTED:\n${admitted.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\nREVIEWER:\n${gaps.map((g, i) => `${i + 1}. ${g.what} (check: ${g.check})`).join('\n') || '(none)'}`;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'system', content: JUDGE }, { role: 'user', content: user }], response_format: { type: 'json_object' }, max_completion_tokens: 3000, reasoning_effort: 'low' }),
    signal: AbortSignal.timeout(90000),
  });
  const j = await res.json();
  return JSON.parse(j.choices[0].message.content);
}
export async function replayCase(file, { env = process.env, model = REVIEW_MODEL } = {}) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  const input = caseToInput(c);
  const r = await callReviewer(input, { env, model, timeoutMs: 60000 });
  if (r.error) return { case: path.basename(file), error: r.error };
  const material = r.gaps.filter((g) => g.severity === 'material');
  const admitted = c.admitted_gaps || [];
  const j = await judge(admitted, material, env);
  const caught = (j.admitted || []).filter((a) => a.caught_by > 0).length;
  return {
    case: path.basename(file), session: c.session_id, card: c.card, foundRealBug: !!c.found_real_bug,
    wouldBlock: material.length > 0, admitted: admitted.length, caught, gaps: material.length,
    specificGaps: (j.reviewer || []).filter((x) => x.specific).length,
    detail: { admitted: admitted.map((a, i) => ({ a, caught_by: (j.admitted || []).find((x) => x.i === i + 1)?.caught_by || 0 })), gaps: material.map((g) => g.what) },
    usage: r.usage,
  };
}

async function cli(argv) {
  meterToSessionLedger();
  const files = argv.filter((a) => !a.startsWith('--'));
  const model = (argv.find((a) => a.startsWith('--model=')) || '').slice(8) || REVIEW_MODEL;
  if (!files.length) { console.error('usage: skeptic-review-replay.mjs <case.json ...> [--json] [--model=id]'); return 2; }
  const rows = [];
  for (const f of files) {
    try { rows.push(await replayCase(f, { model })); } catch (e) { rows.push({ case: path.basename(f), error: e.message }); }
  }
  const ok = rows.filter((r) => !r.error);
  const admitted = ok.reduce((s, r) => s + r.admitted, 0);
  const caught = ok.reduce((s, r) => s + r.caught, 0);
  const summary = { model, cases: rows.length, scored: ok.length, wouldBlock: ok.filter((r) => r.wouldBlock).length, sessionsWithAHit: ok.filter((r) => r.caught > 0).length, admitted, caught, hitRate: admitted ? +(caught / admitted).toFixed(2) : null, gaps: ok.reduce((s, r) => s + r.gaps, 0), specificGaps: ok.reduce((s, r) => s + r.specificGaps, 0) };
  if (argv.includes('--json')) console.log(JSON.stringify({ summary, rows }, null, 1));
  else {
    for (const r of rows) {
      if (r.error) { console.log(`${r.case}: ERROR ${r.error}`); continue; }
      console.log(`\n${r.case} (${r.card || '-'}): would block=${r.wouldBlock}, caught ${r.caught}/${r.admitted} admitted gaps, ${r.specificGaps}/${r.gaps} reviewer gaps specific`);
      for (const a of r.detail.admitted) console.log(`  ${a.caught_by ? 'HIT ' : 'MISS'} ${a.a.slice(0, 150)}`);
      for (const [i, g] of r.detail.gaps.entries()) console.log(`  gap${i + 1}: ${g.slice(0, 150)}`);
    }
    console.log('\nSUMMARY ' + JSON.stringify(summary));
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  cli(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 1; });
}
