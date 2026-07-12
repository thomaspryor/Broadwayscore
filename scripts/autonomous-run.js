#!/usr/bin/env node
/**
 * autonomous-run.js — the nightly executor (Sprint-1 skeleton: PLAN-ONLY).
 *
 * Reads the triage queue (data/audit/autonomous-queue.json, written by
 * scripts/autonomous-triage.js), walks each attempt candidate through the
 * claim → branch → budget → implement → verify pipeline and prints the
 * would-do plan. In --dry-run (the only mode implemented in Sprint 1) it
 * performs ZERO writes: no Notion calls, no git commands that mutate, no
 * files. Sprint 2 adds the real implementer, ledger, and email.
 *
 *   node scripts/autonomous-run.js --dry-run
 *   node scripts/autonomous-run.js --dry-run --night-budget 5 --max-items 3
 *
 * Invariants demonstrated here and preserved by later sprints:
 *   - state changes only via scripts/lib/autonomous-state.js transitions
 *   - budget admission BEFORE claiming (M cards must fit both attempts,
 *     including the possible second-attempt escalation)
 *   - a permission prompt inside an implementer session = card failed
 *     ("needed permission"), run CONTINUES — never a frozen night (the
 *     synthetic probe card exercises this path every dry run)
 */

const fs = require('fs');
const path = require('path');
const { transition } = require('./lib/autonomous-state.js');

const REPO = path.join(__dirname, '..');
const QUEUE_PATH = path.join(REPO, 'data', 'audit', 'autonomous-queue.json');

// Per-card budget envelopes (USD are Anthropic-API estimates; wall minutes
// bound the implementer session). estAttempt2 covers the one allowed retry,
// which may escalate models — admission requires BOTH attempts to fit.
const BUDGET = {
  S: { maxUSD: 1.5, maxWallMin: 30, estUSD: 0.8, estAttempt2USD: 1.6 },
  M: { maxUSD: 3.0, maxWallMin: 90, estUSD: 2.5, estAttempt2USD: 5.0 },
};
const DEFAULT_NIGHT_USD = 5;
const DEFAULT_MAX_ITEMS = 3;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) a[k] = true;
      else { a[k] = n; i++; }
    } else a._.push(t);
  }
  return a;
}

function branchNameFor(card) {
  const slug = String(card.name || card.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `auto/${slug}`;
}

// Simulate one card's night. Every state hop goes through the real state
// machine so an illegal sequence throws loudly here, not in production.
function planCard(item, remainingUSD, opts) {
  const size = item.size;
  const env = BUDGET[size];
  const steps = [];
  let state = 'queued';

  if (!env) {
    return { item, admitted: false, steps: [`refused: size "${size}" has no budget envelope (L cards are split, not attempted)`], state: 'queued' };
  }
  const worstCase = env.estUSD + env.estAttempt2USD;
  if (worstCase > remainingUSD) {
    return {
      item, admitted: false, state: 'queued',
      steps: [`refused: worst-case $${worstCase.toFixed(2)} (attempt1 $${env.estUSD.toFixed(2)} + attempt2 $${env.estAttempt2USD.toFixed(2)}) > remaining $${remainingUSD.toFixed(2)} — stays queued for tomorrow`],
    };
  }

  steps.push(`claim: Notion Status → "In progress", Auto → attempted (notion-tasks-sync then ignores it)`);
  state = transition(state, 'run.claim').next;
  steps.push(`branch: ${branchNameFor(item)} from origin/main (fresh fetch)`);
  steps.push(`implement: claude --settings .claude/autonomous-settings.json (mock in S1; budget $${env.maxUSD}/${env.maxWallMin}min)`);

  if (opts.simulateOutcome === 'permission-prompt') {
    const r = transition(state, 'run.fail', { reason: 'needed permission' });
    state = r.next;
    steps.push(`implementer hit a deny/permission block → run.fail("${r.reason}") → Auto=failed — run CONTINUES with next card`);
    return { item, admitted: true, state, steps, spentUSD: env.estUSD };
  }

  steps.push(`verify: tsc + colocated tests + card's checkableDone (${item.checkableDone || 'n/a'})`);
  steps.push(`diff gate: isDiffAllowed(git diff --name-only) — card text is untrusted, gate runs regardless`);
  steps.push(`push branch + Auto → needs-approval → morning email item`);
  state = transition(state, 'run.pass').next;
  return { item, admitted: true, state, steps, spentUSD: env.estUSD };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['dry-run']) {
    console.error('[run] only --dry-run is implemented in Sprint 1 (plan-only executor). Refusing a live run.');
    process.exit(1);
  }
  const nightUSD = args['night-budget'] ? parseFloat(args['night-budget']) : DEFAULT_NIGHT_USD;
  const maxItems = args['max-items'] ? parseInt(args['max-items'], 10) : DEFAULT_MAX_ITEMS;
  if (!Number.isFinite(nightUSD) || nightUSD <= 0 || !Number.isFinite(maxItems) || maxItems <= 0) {
    console.error('[run] --night-budget and --max-items must be positive numbers');
    process.exit(1);
  }

  const queuePath = args.queue ? path.resolve(String(args.queue)) : QUEUE_PATH;
  if (!fs.existsSync(queuePath)) {
    console.error(`[run] no queue at ${queuePath} — run: node scripts/autonomous-triage.js --dry-run`);
    process.exit(1);
  }
  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  console.log(`# Autonomous night plan (DRY RUN — zero writes)`);
  console.log(`queue: generated ${queue.generatedAt} (${queue.mode}, model ${queue.model})`);
  console.log(`budget: $${nightUSD.toFixed(2)} night total · max ${maxItems} items · triage+email reserve $0.50\n`);

  // Synthetic probe card is prepended EVERY dry run so the failed-not-frozen
  // path is exercised nightly, not just in unit tests.
  const plan = [
    { id: 'probe-permission-prompt', name: '[probe] implementer hits a permission prompt', priority: 'P9', size: 'S', synthetic: true },
    ...queue.plan,
  ];

  let remaining = nightUSD - 0.5; // triage + morning email reserve
  let taken = 0;
  const results = [];
  for (const item of plan) {
    if (taken >= maxItems) {
      results.push({ item, admitted: false, state: 'queued', steps: [`refused: night item cap (${maxItems}) reached — stays queued`] });
      continue;
    }
    const r = planCard(item, remaining, { simulateOutcome: item.synthetic ? 'permission-prompt' : 'pass' });
    if (r.admitted) { remaining -= r.spentUSD; taken++; }
    results.push(r);
  }

  for (const [i, r] of results.entries()) {
    console.log(`${i + 1}. ${r.item.name}  [size ${r.item.size || '?'} · ${r.item.priority || '—'}]`);
    for (const s of r.steps) console.log(`   - ${s}`);
    console.log(`   ⇒ end state: ${r.state}${r.admitted ? ` · est spend $${r.spentUSD.toFixed(2)}` : ''}\n`);
  }
  console.log(`would attempt ${taken} card(s) · est spend $${(nightUSD - 0.5 - remaining).toFixed(2)} of $${(nightUSD - 0.5).toFixed(2)} available · $${remaining.toFixed(2)} unspent`);
  console.log(`writes performed: NONE (plan-only)`);
}

if (require.main === module) main();

module.exports = { planCard, branchNameFor, BUDGET };
