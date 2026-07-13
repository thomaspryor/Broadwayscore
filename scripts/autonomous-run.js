#!/usr/bin/env node
/**
 * autonomous-run.js — the nightly executor (Sprint 2: LIVE).
 *
 * Reads the triage queue (data/audit/autonomous-queue.json, written by
 * scripts/autonomous-triage.js) and walks each attempt candidate through
 * claim → branch → implement → verify → push → needs-approval. The morning
 * email (scripts/autonomous-email.js) then renders the evidence with signed
 * Approve/Reject links.
 *
 *   node scripts/autonomous-run.js --dry-run                 plan only, ZERO writes
 *   node scripts/autonomous-run.js --live                    real night (claude implementer)
 *   node scripts/autonomous-run.js --live --mock-implementer scripts/x.js   (S2-T3 verify)
 *   flags: --night-budget N --max-items N --sizes S,M --queue path --card id
 *
 * Invariants:
 *   - singleton: a second start while a live <6h run holds the pidfile exits 0
 *   - crash recovery first: stranded queued/attempted cards are un-wedged
 *     before any new work (Sprint-2 carry-forward #2)
 *   - state changes only via scripts/lib/autonomous-state.js transitions
 *   - budget admission RESERVES both attempts; attempt-2 refund on a
 *     first-try land (carry-forward #3)
 *   - card text and queue file are untrusted: the eligibility gate runs on
 *     the RESULTING diff, and checkableDone is re-validated at exec time
 *   - any failure fails THAT CARD and the run continues — never a frozen night
 *   - nothing is ever pushed to any main; branches only (auto/* namespace)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { transition } = require('./lib/autonomous-state.js');
const { isDiffAllowed } = require('./lib/autonomous-eligibility.js');
const { isSafeCheckCommand } = require('./lib/autonomous-triage-core.js');
const { createNightBudget, checkSharedDailyCap, pickModel, ENVELOPES } = require('./lib/autonomous-budget.js');
const ledger = require('./lib/autonomous-ledger.js');
const {
  buildImplementerPrompt, parseClaudeJson, classifyFailure, decideChecks, cardCheckArgv, shouldThrottle,
} = require('./lib/autonomous-run-core.js');

const REPO = path.join(__dirname, '..');
const QUEUE_PATH = path.join(REPO, 'data', 'audit', 'autonomous-queue.json');
const CONFIG_PATH = path.join(REPO, '.claude', 'autonomous-config.json');
const SETTINGS_PATH = path.join(REPO, '.claude', 'autonomous-settings.json');
const WORKTREE_ROOT = path.join(REPO, '.claude', 'worktrees');
const QUEUE_MAX_AGE_H = 12;
const CHECK_TIMEOUT_MS = 5 * 60 * 1000;

// .env may be absent in a worktree (gitignored) — fall back to the primary
// checkout so NOTION_API_KEY resolves either way (pattern from triage).
for (const envPath of [path.join(REPO, '.env'), '/Users/tompryor/Broadwayscore/.env']) {
  if (!fs.existsSync(envPath)) continue;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    if (!process.env[t.slice(0, eq)]) process.env[t.slice(0, eq)] = t.slice(eq + 1);
  }
  break;
}

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

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

function notionBrain(args) {
  const out = execFileSync('node', [path.join(__dirname, 'notion-brain.js'), ...args], {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  return JSON.parse(out);
}

function notionUpdate(id, flags) {
  execFileSync('node', [path.join(__dirname, 'notion-brain.js'), 'update', id, ...flags], {
    cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'], env: process.env,
  });
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function branchNameFor(card) {
  const slug = String(card.name || card.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  // Card-id suffix keeps similarly-titled cards (e.g. recurring "Missing
  // show:" cards) from colliding onto one branch.
  const idFrag = String(card.id || '').replace(/-/g, '').slice(-6) || 'noid';
  return `auto/${slug}-${idFrag}`;
}

// ── Dry-run planner (Sprint 1 behavior, preserved) ──────────────────────────

function planCard(item, remainingUSD, opts) {
  const env = ENVELOPES[item.size];
  const steps = [];
  let state = 'queued';

  if (!env) {
    return { item, admitted: false, steps: [`refused: size "${item.size}" has no budget envelope (L cards are worked incrementally, never admitted whole)`], state: 'queued' };
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
  steps.push(`implement: claude --settings .claude/autonomous-settings.json (budget $${env.maxUSD}/${env.maxWallMin}min)`);

  if (opts.simulateOutcome === 'permission-prompt') {
    const r = transition(state, 'run.fail', { reason: 'needed permission' });
    state = r.next;
    steps.push(`implementer hit a deny/permission block → run.fail("${r.reason}") → Auto=failed — run CONTINUES with next card`);
    return { item, admitted: true, state, steps, spentUSD: env.estUSD, reservedUSD: worstCase };
  }

  steps.push(`verify: colocated tests + card's checkableDone (${item.checkableDone || 'n/a'})`);
  steps.push(`diff gate: isDiffAllowed(git diff --name-only) — card text is untrusted, gate runs regardless`);
  steps.push(`push branch + Auto → needs-approval → morning email item`);
  state = transition(state, 'run.pass').next;
  return { item, admitted: true, state, steps, spentUSD: env.estUSD, reservedUSD: worstCase };
}

function dryRun(args, cfg) {
  const nightUSD = num(args['night-budget'], cfg.nightUSD ?? 5);
  const maxItems = num(args['max-items'], cfg.maxItems ?? 3);
  const queue = readQueue(args, { allowStale: true });

  console.log(`# Autonomous night plan (DRY RUN — zero writes)`);
  console.log(`queue: generated ${queue.generatedAt} (${queue.mode}, model ${queue.model})`);
  console.log(`budget: $${nightUSD.toFixed(2)} night total · max ${maxItems} items · triage+email reserve $0.50\n`);

  // Synthetic probe card is prepended EVERY dry run so the failed-not-frozen
  // path is exercised nightly, not just in unit tests.
  const plan = [
    { id: 'probe-permission-prompt', name: '[probe] implementer hits a permission prompt', priority: 'P9', size: 'S', synthetic: true },
    ...queue.plan,
  ];

  let remaining = nightUSD - 0.5;
  let taken = 0;
  const results = [];
  for (const item of plan) {
    if (taken >= maxItems) {
      results.push({ item, admitted: false, state: 'queued', steps: [`refused: night item cap (${maxItems}) reached — stays queued`] });
      continue;
    }
    const r = planCard(item, remaining, { simulateOutcome: item.synthetic ? 'permission-prompt' : 'pass' });
    if (r.admitted) { remaining -= r.reservedUSD; taken++; }
    results.push(r);
  }

  for (const [i, r] of results.entries()) {
    console.log(`${i + 1}. ${r.item.name}  [size ${r.item.size || '?'} · ${r.item.priority || '—'}]`);
    for (const s of r.steps) console.log(`   - ${s}`);
    console.log(`   ⇒ end state: ${r.state}${r.admitted ? ` · est spend $${r.spentUSD.toFixed(2)} (reserved $${r.reservedUSD.toFixed(2)} incl. retry)` : ''}\n`);
  }
  console.log(`would attempt ${taken} card(s) · $${remaining.toFixed(2)} unreserved`);
  console.log(`writes performed: NONE (plan-only)`);
}

// ── Live executor ───────────────────────────────────────────────────────────

function readQueue(args, { allowStale = false } = {}) {
  const queuePath = args.queue ? path.resolve(String(args.queue)) : QUEUE_PATH;
  if (!fs.existsSync(queuePath)) {
    console.error(`[run] no queue at ${queuePath} — run: node scripts/autonomous-triage.js`);
    process.exit(1);
  }
  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  const ageH = (Date.now() - new Date(queue.generatedAt).getTime()) / 3600e3;
  if (!allowStale && !(ageH < QUEUE_MAX_AGE_H)) {
    console.error(`[run] queue is ${ageH.toFixed(1)}h old (max ${QUEUE_MAX_AGE_H}h) — re-run triage first`);
    process.exit(1);
  }
  return queue;
}

function listCardsByAuto(state) {
  try { return notionBrain(['list', '--auto', state, '--limit', '100']); }
  catch (err) {
    console.error(`[run] WARN could not list --auto ${state}: ${err.message.slice(0, 120)}`);
    return null; // null = unknown, callers must fail safe
  }
}

// Crash recovery (carry-forward #2): un-wedge cards stranded by a dead run.
function runRecovery(planIds, runId) {
  const attempted = listCardsByAuto('attempted');
  const queued = listCardsByAuto('queued');
  if (attempted === null || queued === null) {
    console.error('[run] recovery skipped (Notion listing failed) — stranded cards will be retried tomorrow');
    return;
  }
  const autoCards = [
    ...attempted.map(c => ({ id: c.id, auto: 'attempted' })),
    ...queued.map(c => ({ id: c.id, auto: 'queued' })),
  ];
  for (const a of ledger.recoveryActions(autoCards, planIds)) {
    try {
      if (a.action === 'fail') {
        transition('attempted', 'run.fail', { reason: a.reason }); // validate the move
        notionUpdate(a.id, ['--auto', 'failed']);
      } else {
        notionUpdate(a.id, ['--auto', 'clear']);
      }
      ledger.appendEntry({ event: 'recovery', runId, cardId: a.id, note: `${a.action}: ${a.reason}` });
      console.error(`[run] recovery: ${a.id} → ${a.action} (${a.reason})`);
    } catch (err) {
      console.error(`[run] WARN recovery failed for ${a.id}: ${err.message.slice(0, 120)}`);
    }
  }
}

// The implementer (and anything it wrote) is UNTRUSTED — it must never see
// the session's secret-bearing environment (.env is fully loaded into
// process.env: Notion/Resend/HMAC/Vercel tokens). Ship-check P0 2026-07-13:
// a prompt-injected implementer could otherwise exfiltrate secrets or forge
// approve links. claude CLI gets only what it needs to run and bill.
function implementerEnv() {
  const keep = ['PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL', 'ANTHROPIC_API_KEY', 'NODE_ENV'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

// Checks execute implementer-AUTHORED code (a planted tests/x.test.mjs runs
// under node --test). Beyond the secret-free env, point HOME at an empty
// temp dir so the git osxkeychain credential helper (configured in the real
// ~/.gitconfig) is unreachable — a malicious check can't push with the
// owner's credentials — and disable git prompting so it fails fast.
function checksEnv() {
  const env = implementerEnv();
  delete env.ANTHROPIC_API_KEY;
  const fakeHome = fs.mkdtempSync(path.join(require('os').tmpdir(), 'auto-checks-home-'));
  env.HOME = fakeHome;
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function runImplementer(item, card, workdir, model, maxWallMin, mockScript) {
  const t0 = Date.now();
  if (mockScript) {
    const r = spawnSync('node', [path.resolve(String(mockScript))], {
      cwd: workdir, encoding: 'utf8', timeout: maxWallMin * 60e3,
      env: { ...implementerEnv(), CARD_JSON: JSON.stringify({ ...item, notes: card.notes || '' }) },
    });
    if (r.status !== 0) return { ok: false, stage: 'implementer-error', error: `mock exited ${r.status}: ${String(r.stderr || '').slice(0, 200)}`, usd: 0, tokensIn: 0, tokensOut: 0, wallMin: (Date.now() - t0) / 60e3 };
    return { ok: true, usd: 0, tokensIn: 0, tokensOut: 0, resultText: String(r.stdout || '').trim().slice(0, 500) || 'mock implementer ran', wallMin: (Date.now() - t0) / 60e3 };
  }

  const prompt = buildImplementerPrompt(card, item);
  const r = spawnSync('claude', [
    '--dangerously-skip-permissions',
    '--settings', SETTINGS_PATH,
    '--model', model,
    '-p', prompt,
    '--output-format', 'json',
  ], { cwd: workdir, encoding: 'utf8', timeout: maxWallMin * 60e3, maxBuffer: 32 * 1024 * 1024, env: implementerEnv() });

  const wallMin = (Date.now() - t0) / 60e3;
  if (r.error && r.error.code === 'ETIMEDOUT') return { ok: false, stage: 'timeout', error: `implementer exceeded ${maxWallMin}min wall clock`, usd: 0, tokensIn: 0, tokensOut: 0, wallMin };
  if (r.error) return { ok: false, stage: 'implementer-error', error: r.error.message, usd: 0, tokensIn: 0, tokensOut: 0, wallMin };
  const parsed = parseClaudeJson(r.stdout);
  if (!parsed.ok && parsed.error === 'unparseable claude CLI output') {
    return { ok: false, stage: 'parse-error', error: `${parsed.error} (exit ${r.status})`, usd: 0, tokensIn: 0, tokensOut: 0, wallMin };
  }
  if (!parsed.ok) return { ok: false, stage: 'implementer-gave-up', error: parsed.error, ...pickUsage(parsed), wallMin };
  if (r.status !== 0) return { ok: false, stage: 'implementer-error', error: `claude exited ${r.status}`, ...pickUsage(parsed), wallMin };
  return { ok: true, resultText: parsed.resultText, ...pickUsage(parsed), wallMin };
}

function pickUsage(p) { return { usd: p.usd, tokensIn: p.tokensIn, tokensOut: p.tokensOut }; }

function runChecks(workdir, changedFiles, checkableDone) {
  const results = [];
  const checks = decideChecks(changedFiles, f => fs.existsSync(path.join(workdir, f)));
  const cardArgv = cardCheckArgv(checkableDone, isSafeCheckCommand);
  if (cardArgv) checks.push({ name: `card-check (${checkableDone})`, argv: cardArgv });
  else if (checkableDone) results.push({ name: 'card-check', pass: false, detail: `checkableDone failed safe-form validation: ${String(checkableDone).slice(0, 120)}` });

  const env = checksEnv();
  for (const c of checks) {
    try {
      execFileSync(c.argv[0], c.argv.slice(1), { cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'], timeout: CHECK_TIMEOUT_MS, encoding: 'utf8', env });
      results.push({ name: c.name, pass: true });
    } catch (err) {
      results.push({ name: c.name, pass: false, detail: String(err.stderr || err.stdout || err.message).slice(0, 400) });
    }
  }
  return results;
}

function attemptCard(item, budget, cfg, runId, opts) {
  // Freshness guard BEFORE admission so skipped cards never consume the
  // night's item slots or reservations (ship-check finding): a human or a
  // day-dispatched workspace may have moved the card since triage — the
  // Status flip is the cross-session claim signal.
  let card;
  try { card = notionBrain(['get', item.id]); }
  catch (err) {
    ledger.appendEntry({ event: 'card-skip', runId, cardId: item.id, name: item.name, note: `fetch failed: ${err.message.slice(0, 120)}` });
    return;
  }
  if (card.status !== 'Not started' || card.auto !== 'queued') {
    ledger.appendEntry({ event: 'card-skip', runId, cardId: item.id, name: item.name, note: `state moved underneath us (status=${card.status}, auto=${card.auto || 'none'})` });
    console.error(`[run] skip ${item.name}: claimed elsewhere (status=${card.status}, auto=${card.auto || 'none'})`);
    return;
  }

  const adm = budget.admit(item.id, item.size);
  if (!adm.admitted) {
    console.error(`[run] skip ${item.name}: ${adm.reason}`);
    ledger.appendEntry({ event: 'card-skip', runId, cardId: item.id, name: item.name, note: adm.reason });
    return;
  }

  // Claim. The Status→"In progress" flip is what keeps notion-tasks-sync /
  // bsc-next from double-picking (regression-tested in notion-tasks-sync.test.mjs).
  transition('queued', 'run.claim');
  notionUpdate(item.id, ['--status', 'In progress', '--auto', 'attempted']);
  ledger.appendEntry({ event: 'claim', runId, cardId: item.id, name: item.name });

  const branch = branchNameFor(item);
  const workdir = path.join(WORKTREE_ROOT, `auto-${branch.split('/')[1]}`);
  const env = ENVELOPES[item.size];
  let totalUSD = 0;
  let failureKind = null;

  const fail = (stage, reason) => {
    transition('attempted', 'run.fail', { reason });
    // Un-wedge the card for humans (ship-check P1): Auto=failed keeps the
    // loop off it, Status back to "Not started" returns it to the human
    // backlog, and the reason lands ON the card so the email's "details on
    // the cards" line is true (the ledger is local and gitignored).
    try {
      notionUpdate(item.id, ['--auto', 'failed', '--status', 'Not started',
        '--outcome', `## Autonomous attempt failed (${new Date().toISOString().slice(0, 10)})\n${stage}: ${String(reason).slice(0, 400)}\n\nBranch was not merged; the loop will not retry this card (Auto=failed) — clear Auto to re-queue it.`]);
    } catch (e) { console.error(`[run] WARN could not flip ${item.id} to failed: ${e.message.slice(0, 120)}`); }
    // totalUSD (not usd): spend is ledgered on the per-attempt implement
    // lines — a terminal line carrying usd would double-count the night.
    ledger.appendEntry({ event: 'card-fail', runId, cardId: item.id, name: item.name, totalUSD: round2(totalUSD), note: `${stage}: ${String(reason).slice(0, 300)}` });
    console.error(`[run] FAIL ${item.name} [${stage}] ${reason}`);
  };

  try {
    git(REPO, ['fetch', 'origin', 'main']);
    // NEVER delete a pre-existing branch or workdir — it may belong to a
    // previous pending attempt or a live interactive session (ship-check P0;
    // same refusal pattern as auto-fix-friction-card.js branchExists).
    let remoteBranch = '';
    try { remoteBranch = git(REPO, ['ls-remote', '--heads', 'origin', branch]).trim(); } catch { /* treat as absent */ }
    if (remoteBranch) {
      budget.settle(item.id, 0);
      fail('branch-error', `branch ${branch} already exists on origin (pending previous attempt?) — refusing to overwrite`);
      return;
    }
    if (fs.existsSync(workdir)) {
      budget.settle(item.id, 0);
      fail('branch-error', `workdir ${workdir} already exists (another session?) — refusing to remove it`);
      return;
    }
    git(REPO, ['worktree', 'add', '-B', branch, workdir, 'origin/main']);
  } catch (err) {
    budget.settle(item.id, 0);
    fail('branch-error', err.message.slice(0, 200));
    return;
  }

  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt === 2) {
        // Retry starts clean — attempt 1's bad diff must not contaminate it.
        git(workdir, ['reset', '--hard', 'origin/main']);
        git(workdir, ['clean', '-fd']);
      }
      const model = pickModel(attempt, failureKind);
      console.error(`[run] ${item.name}: attempt ${attempt} (${opts.mockScript ? 'mock' : model})`);
      const imp = runImplementer(item, card, workdir, model, env.maxWallMin, opts.mockScript);
      totalUSD = round2(totalUSD + imp.usd);
      ledger.appendEntry({
        event: 'implement', runId, cardId: item.id, name: item.name, attempt,
        model: opts.mockScript ? 'mock' : model, usd: imp.usd, tokensIn: imp.tokensIn, tokensOut: imp.tokensOut,
        note: imp.ok ? `ok in ${imp.wallMin.toFixed(1)}min` : `${imp.stage}: ${String(imp.error).slice(0, 200)}`,
      });

      let stage = null, detail = null, evidence = null;
      if (!imp.ok) { stage = imp.stage; detail = imp.error; }
      else {
        const cut = budget.shouldAbort(item.size, { elapsedMin: imp.wallMin, attemptUSD: imp.usd });
        if (cut.abort) { stage = 'budget'; detail = cut.reason; }
      }

      if (!stage) {
        // Commit anything the implementer left uncommitted, then gate the diff.
        try {
          if (git(workdir, ['status', '--porcelain']).trim()) {
            git(workdir, ['add', '-A']);
            git(workdir, ['commit', '-q', '-m', `auto: ${item.name} (executor commit)`]);
          }
          const files = git(workdir, ['diff', '--name-only', 'origin/main...HEAD']).trim().split('\n').filter(Boolean);
          if (!files.length) { stage = 'empty-diff'; detail = 'implementer produced no changes'; }
          else {
            const gate = isDiffAllowed(files);
            if (!gate.allowed) { stage = 'diff-refused'; detail = `ineligible paths: ${gate.refused.join(', ')}`; }
            else {
              const checks = runChecks(workdir, files, item.checkableDone);
              const failed = checks.filter(c => !c.pass);
              if (failed.length) { stage = 'checks-failed'; detail = failed.map(c => `${c.name}: ${c.detail}`).join(' | ').slice(0, 500); }
              else evidence = { branch, files, checks: checks.map(c => `${c.name}: PASS`), summary: (imp.resultText || '').slice(0, 600) };
            }
          }
        } catch (err) { stage = 'git-error'; detail = err.message.slice(0, 200); }
      }

      if (evidence) {
        // Plain push: the branch was refused above if it pre-existed, so a
        // rejection here means something else claimed it mid-run — fail, don't force.
        try { git(workdir, ['push', '-u', 'origin', branch]); }
        catch (err) { stage = 'push-error'; detail = err.message.slice(0, 200); }
      }

      if (!stage) {
        if (attempt === 1) budget.refundAttempt2(item.id, item.size); // carry-forward #3
        transition('attempted', 'run.pass');
        notionUpdate(item.id, ['--auto', 'needs-approval']);
        ledger.appendEntry({ event: 'card-pass', runId, cardId: item.id, name: item.name, totalUSD: round2(totalUSD), attempt, evidence });
        console.error(`[run] PASS ${item.name} → ${branch} ($${totalUSD.toFixed(2)})`);
        return;
      }

      failureKind = classifyFailure(stage);
      const cutOff = budget.shouldAbort(item.size, { attemptUSD: totalUSD });
      if (attempt === 2 || stage === 'budget' || cutOff.abort) { fail(stage, detail); return; }
      console.error(`[run] attempt 1 failed [${stage}] (${failureKind}) — retrying${failureKind === 'content' ? ' on Opus' : ''}`);
    }
  } finally {
    budget.settle(item.id, totalUSD);
    try { git(REPO, ['worktree', 'remove', '--force', workdir]); } catch { /* leave for manual GC */ }
  }
}

async function live(args, cfg) {
  const mockScript = args['mock-implementer'] || null;
  const nightUSD = num(args['night-budget'], cfg.nightUSD ?? 5);
  const maxItems = num(args['max-items'], cfg.maxItems ?? 3);
  const sizes = args.sizes ? String(args.sizes).split(',').map(s => s.trim()) : (cfg.sizes || ['S']);

  const lock = ledger.acquireSingleton();
  if (!lock.acquired) {
    console.log(`[run] already running (pid ${lock.holder?.pid}, started ${lock.holder?.startedAt}) — exiting`);
    process.exit(0);
  }
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  try {
    const cap = checkSharedDailyCap(nightUSD);
    if (!cap.ok) { console.error(`[run] ${cap.message}`); process.exit(1); }
    if (cap.warning) console.error(`[run] WARN ${cap.warning}`);

    const queue = readQueue(args);
    let plan = queue.plan;
    if (args.card) plan = plan.filter(p => p.id === args.card || p.id.replace(/-/g, '') === String(args.card).replace(/-/g, ''));

    ledger.appendEntry({ event: 'run-start', runId, note: `budget $${nightUSD} · max ${maxItems} · sizes ${sizes.join(',')} · ${plan.length} plan item(s)${mockScript ? ' · MOCK implementer' : ''}` });

    runRecovery(new Set(plan.map(p => p.id)), runId);

    // Approval-fatigue throttle: too many un-tapped items → no new attempts.
    const open = listCardsByAuto('needs-approval');
    if (open === null || shouldThrottle(open.length)) {
      const why = open === null ? 'could not count open approvals (failing safe)' : `${open.length} items already await approval (max 8)`;
      ledger.appendEntry({ event: 'run-end', runId, note: `throttled: ${why}` });
      console.log(`[run] THROTTLED — ${why}. No new attempts tonight.`);
      return;
    }

    const budget = createNightBudget({ nightUSD, maxItems, sizes, weeklyUSD: cfg.weeklyUSD ?? null });
    for (const item of plan) attemptCard(item, budget, cfg, runId, { mockScript });

    const s = budget.state();
    ledger.appendEntry({ event: 'run-end', runId, note: `spent $${s.spent.toFixed(2)} of $${nightUSD} · ${s.items} attempted` });
    console.log(`[run] night done: ${s.items} attempted · $${s.spent.toFixed(2)} spent · ledger ${ledger.LEDGER_PATH}`);
  } finally {
    ledger.releaseSingleton();
  }
}

function num(v, dflt) {
  if (v === undefined) return dflt;
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n <= 0) { console.error(`[run] flag must be a positive number, got ${JSON.stringify(v)}`); process.exit(1); }
  return n;
}

function round2(n) { return Math.round(n * 100) / 100; }

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if (args['dry-run']) return dryRun(args, cfg);
  if (args.live) return live(args, cfg);
  console.error('[run] pass --dry-run (plan only) or --live (real night)');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { planCard, branchNameFor, attemptCard, runRecovery, readQueue };
