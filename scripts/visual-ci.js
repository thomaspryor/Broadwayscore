#!/usr/bin/env node
/**
 * visual-ci.js (BRO-7495, Phase 2) — the trusted half of the CI before/after check.
 *
 *   node scripts/visual-ci.js plan   --branch=visual-hold/bro-N --out=plan.json
 *   node scripts/visual-ci.js record --branch=visual-hold/bro-N --head-sha=<sha> --base-sha=<sha> --shots=<dir> [--dry-run]
 *
 * `plan` runs in the untrusted capture job (no secrets) from MAIN's copy of this file and says what to photograph.
 * `record` runs in visual-identical-record.yml (main's code, holds APPROVAL_HMAC_SECRET): it recomputes the patch
 * and the plan itself, compares the uploaded pictures itself (the artifact is data, never a verdict), and posts ONE
 * signed "Visual CI result VQK<mac>" comment on the card. It never approves anything; the lander decides.
 * Exit: 0 wrote a result or skipped a stale run, 1 could not finish (the run is red), 2 usage.
 */
'use strict';
require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const path = require('path');
const va = require('./lib/visual-approval.js');
const ci = require('./lib/visual-ci.js');
const ident = require('./lib/visual-identical.js');
const { WIDTHS } = { WIDTHS: [360, 414, 768, 1024, 1440] }; // same list as scripts/lib/visual-capture.mjs (an .mjs cannot be require()d); a test pins them equal
const link = require('../src/lib/owner-decision-link.js');

const BRANCH_RE = /^visual-hold\/(bro-\d+)$/;
function arg(argv, name) { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : ''; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Facts about the held change, all read from git (never from the artifact). */
function holdFacts(branch, cwd = process.cwd()) {
  const m = BRANCH_RE.exec(branch);
  if (!m) throw new Error(`not a visual-hold branch: ${branch}`);
  const id = m[1].toUpperCase();
  const ev = va.evidenceBranch(id);
  va.git(['fetch', '--quiet', 'origin', 'main', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd });
  let verdict = null;
  try {
    va.git(['fetch', '--quiet', 'origin', `+refs/heads/${ev}:refs/remotes/origin/${ev}`], { cwd });
    verdict = JSON.parse(va.git(['show', `origin/${ev}:verdict.json`], { cwd }));
  } catch { /* no evidence yet: the plan is blocked below */ }
  const headSha = va.git(['rev-parse', `origin/${branch}`], { cwd });
  const changedFiles = va.git(['diff', '--name-only', `origin/main...origin/${branch}`], { cwd }).split('\n').filter(Boolean);
  const diffText = va.git(['diff', `origin/main...origin/${branch}`, '--', 'src'], { cwd });
  const patch = va.patchId('origin/main', `origin/${branch}`, cwd);
  return { id, headSha, changedFiles, diffText, patch, verdict };
}

function buildPlan(facts) {
  // The evidence verdict must be the very check made on this commit; otherwise its routes and elements describe another change.
  if (!facts.verdict || facts.verdict.headSha !== facts.headSha) return { blocked: 'the visual check evidence is missing or was made on another commit' };
  return ci.planCapture({ changedFiles: facts.changedFiles, verdict: facts.verdict, diffText: facts.diffText });
}

const keyOf = (p) => `${String(p.route).replace(/\W+/g, '_')}_${p.width}_${(p.state || 'page').replace(/\W+/g, '_')}`;

/** Compare the artifact's pictures with the strict rule. The manifest only says which pairs exist; every verdict is recomputed here. */
async function comparePairs(shots, plan, manifest) {
  const out = [];
  const want = ci.expectedPairs(plan, WIDTHS);
  const have = new Map((Array.isArray(manifest.pairs) ? manifest.pairs : []).filter((p) => p && typeof p === 'object').map((p) => [ci.pairKey(p), p]));
  const found = new Set();
  for (const e of want) {
    const p = have.get(ci.pairKey(e));
    if (!p) continue; // absent: evaluate() reports it as incomplete
    const pair = { route: e.route, width: e.width, state: e.state };
    if (p.status !== 'error' && ![p.domBase, p.domHead, p.domHead2].every((d) => typeof d === 'string' && d)) { out.push({ ...pair, status: 'error', reason: 'the capture manifest lacks page fingerprints' }); continue; }
    if (p.status === 'error') { out.push({ ...pair, status: 'error', reason: String(p.reason || 'capture error').slice(0, 160) }); continue; }
    const key = keyOf(e); // never trust a manifest-supplied file name
    const f = (n) => path.join(shots, `${key}.${n}.png`);
    const self = await ident.compareImages(f('head'), f('head2'), ci.STRICT);
    if (!self.same || p.domHead !== p.domHead2) { out.push({ ...pair, status: 'different', reason: 'the new page does not render the same twice in a row (animated or live content)' }); continue; }
    const cmp = await ident.compareImages(f('base'), f('head'), ci.STRICT);
    if (!cmp.same) { out.push({ ...pair, status: 'different', reason: cmp.reason }); continue; }
    if (p.domBase !== p.domHead) { out.push({ ...pair, status: 'different', reason: 'the page text, links or tags differ' }); continue; }
    out.push({ ...pair, status: 'same', reason: '' });
    for (const s of Array.isArray(p.found) ? p.found : []) if ((plan.elements || []).includes(s)) found.add(s);
  }
  return { pairs: out, elementsFound: [...found] };
}

async function plan(argv) {
  const branch = arg(argv, 'branch'); const out = arg(argv, 'out');
  if (!BRANCH_RE.test(branch) || !out) { console.error('Usage: visual-ci.js plan --branch=visual-hold/bro-N --out=plan.json'); return 2; }
  let p = null;
  for (let i = 0; i < 6 && (!p || p.blocked); i++) { // the evidence branch is pushed just after the hold branch
    p = buildPlan(holdFacts(branch));
    if (p.blocked && /evidence/.test(p.blocked) && i < 5) await sleep(20000); else break;
  }
  fs.writeFileSync(out, JSON.stringify(p, null, 2));
  console.log(p.blocked ? `[visual-ci] blocked: ${p.blocked}` : `[visual-ci] plan: ${p.routes.length} page(s), ${p.elements.length} element(s)`);
  return 0;
}

async function record(argv) {
  const branch = arg(argv, 'branch'); const shots = arg(argv, 'shots');
  const headSha = arg(argv, 'head-sha'); const baseSha = arg(argv, 'base-sha');
  const dryRun = argv.includes('--dry-run');
  if (!BRANCH_RE.test(branch) || !shots || !/^[0-9a-f]{40}$/.test(headSha) || !/^[0-9a-f]{40}$/.test(baseSha)) { console.error('Usage: visual-ci.js record --branch=visual-hold/bro-N --head-sha=<sha> --base-sha=<sha> --shots=<dir> [--dry-run]'); return 2; }
  const secret = process.env.APPROVAL_HMAC_SECRET;
  if (!secret) { console.error('[visual-ci] APPROVAL_HMAC_SECRET is not set'); return dryRun ? 0 : 1; }
  const facts = holdFacts(branch);
  if (facts.headSha !== headSha) { console.log(`[visual-ci] stale run: ${branch} moved on from ${headSha.slice(0, 9)}; skipping`); return 0; }
  try { va.git(['merge-base', '--is-ancestor', baseSha, 'origin/main']); } catch { console.error('[visual-ci] the capture base is not an ancestor of main; refusing'); return 1; }
  if (!facts.patch) { console.log('[visual-ci] the hold has no difference from main; skipping'); return 0; }
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(shots, 'manifest.json'), 'utf8')); } catch { manifest = {}; }
  const pl = buildPlan(facts);
  let result;
  if (pl.blocked) result = ci.evaluate({ plan: pl, widths: WIDTHS });
  else {
    const { pairs, elementsFound } = await comparePairs(shots, pl, manifest);
    let canaryOk = false;
    if (manifest.canary === true) canaryOk = (await ident.compareImages(path.join(shots, 'canary.a.png'), path.join(shots, 'canary.b.png'), ci.STRICT)).same === false;
    result = ci.evaluate({ plan: pl, pairs, canaryOk, elementsFound, widths: WIDTHS });
  }
  console.log(`[visual-ci] ${facts.id}: ${result.outcome}${result.reasons.length ? ` (${result.reasons[0]})` : ''}`);
  const linear = require('./lib/linear-client.js');
  // The ask is written just after the hold is pushed; wait for the card to carry this patch before signing for it.
  let issue = null;
  for (let i = 0; i < 12; i++) {
    issue = await linear.getIssue(facts.id);
    const v = issue && link.parseVisualApproval(issue.description);
    if (v && v.patch === facts.patch) break;
    issue = null;
    if (!dryRun) await sleep(30000); else break;
  }
  if (!issue) { console.log(`[visual-ci] ${facts.id}: the card does not carry this patch (no ask, or a newer one); nothing recorded`); return 0; }
  const body = ci.buildCiComment({ secret, id: facts.id, patch: facts.patch, outcome: result.outcome, base: baseSha, digest: result.digest, reasons: result.reasons, armed: ci.autoShipOn(process.env) });
  const existing = (await linear.listIssueComments([facts.id])).get(facts.id) || [];
  const same = ci.findCiResult(existing, secret, facts.id, facts.patch);
  if (same && same.outcome === result.outcome && same.digest === result.digest && same.base === baseSha) { console.log(`[visual-ci] ${facts.id}: already recorded`); return 0; }
  if (dryRun) { console.log(`[dry-run] would comment:\n${body}`); return 0; }
  await linear.createComment(issue.id, body);
  console.log(`[visual-ci] ${facts.id}: recorded ${result.outcome}`);
  return 0;
}

async function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'plan') return plan(argv.slice(1));
  if (argv[0] === 'record') return record(argv.slice(1));
  console.error('Usage: node scripts/visual-ci.js plan|record ...');
  return 2;
}

if (require.main === module) {
  main().then((c) => { process.exitCode = c; }, (e) => { console.error(`[visual-ci] ${e.stack || e.message}`); process.exitCode = 1; });
}
module.exports = { holdFacts, buildPlan, comparePairs, keyOf, WIDTHS };
