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
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');

const https = require('https');
const { transition } = require('./lib/autonomous-state.js');
const { isDiffAllowed, isCodeDiffAllowed, classifyDataCard, DATA_CLASS_REPO, isDataRepoDiffAllowed } = require('./lib/autonomous-eligibility.js');
const { isSafeCheckCommand } = require('./lib/autonomous-triage-core.js');
const { createNightBudget, clampNightToWeekly, checkSharedDailyCap, pickModel, ENVELOPES, inadmissibleSizes, spendCircuitBreakerStatus } = require('./lib/autonomous-budget.js');
const ledger = require('./lib/autonomous-ledger.js');
const { computeContentHash } = require('./lib/attempt-memory.js');
const {
  buildImplementerPrompt, buildDataImplementerPrompt, parseClaudeJson, classifyFailure, shouldThrottle, preflightVerdict,
  resolveOwnerEmail, isAutoMergeable,
} = require('./lib/autonomous-run-core.js');
const { evidenceCommentText } = require('./lib/autonomous-notion-evidence.js');
const { captureUiScreenshots } = require('./lib/autonomous-ui-capture.js');
const { runSafeChecks, checksEnv, isUiDiff, tierOf, decideChecks } = require('./lib/autonomous-checks.js');
const {
  isIncrementalSize, classifyLCardOutcome, nightNumberFor, buildResumeNote, buildFirstNightNote, buildCheckpointNote,
} = require('./lib/autonomous-checkpoint.js');
const {
  buildDataWorkdir, removeDataWorkdir, pushDataBranch, showIdsFromReviewTextsDiff, primaryWorktree,
  scorecardDataRoot, reviewTextsRoot,
} = require('./lib/autonomous-data-workdir.js');
const { verifierArgvFor } = require('./lib/autonomous-data-verify.js');

const REPO = path.join(__dirname, '..');
const QUEUE_PATH = path.join(REPO, 'data', 'audit', 'autonomous-queue.json');
const CONFIG_PATH = path.join(REPO, '.claude', 'autonomous-config.json');
const SETTINGS_PATH = path.join(REPO, '.claude', 'autonomous-settings.json');
const WORKTREE_ROOT = path.join(REPO, '.claude', 'worktrees');
const QUEUE_MAX_AGE_H = 12;
// Tier-2's deterministic verifiers reuse the shared per-check wall clock —
// one definition (scripts/lib/autonomous-checks.js), not a second 5-minute
// literal that can drift from the gauntlet's.
const CHECK_TIMEOUT_MS = require('./lib/autonomous-checks.js').CHECK_TIMEOUT_MS;

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

// Durable evidence for the CI merge path (Sprint 3): the ledger is
// Mac-Studio-local and gitignored (S2-T7), so autonomous-merge.yml (which
// runs in GitHub Actions) has no other way to read a passed card's
// checkableDone. Posted as a Notion comment — non-fatal on failure (the
// merge workflow falls back to tsc+colocated-tests only; card-pass already
// happened either way).
function postEvidenceComment(cardId, evidence) {
  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) { console.error('[run] WARN NOTION_API_KEY not set — cannot post evidence comment'); return; }
  const body = JSON.stringify({
    parent: { page_id: cardId },
    rich_text: [{ text: { content: evidenceCommentText(evidence) } }],
  });
  try {
    const req = require('https').request({
      hostname: 'api.notion.com', path: '/v1/comments', method: 'POST',
      headers: {
        'Authorization': `Bearer ${notionKey}`, 'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      },
    }, res => { res.resume(); if (res.statusCode >= 300) console.error(`[run] WARN evidence comment POST returned ${res.statusCode}`); });
    req.on('error', err => console.error(`[run] WARN evidence comment POST failed: ${err.message}`));
    req.write(body);
    req.end();
  } catch (err) { console.error(`[run] WARN evidence comment POST threw: ${err.message}`); }
}

// Dispatch autonomous-merge.yml and wait for it (Sprint 3 deterministic-green
// path: the executor itself triggers the merge, no human tap). Returns
// { dispatched, runId } — runId is null if we couldn't resolve it (dispatch
// may still have gone through; the card's Auto state is the source of truth
// either way, checked by the caller after this returns).
function dispatchAndWaitMerge(cardId, branch, action, timeoutMin) {
  const dispatch = spawnSync('gh', [
    'workflow', 'run', 'autonomous-merge.yml',
    '-f', `card_id=${cardId}`, '-f', `branch=${branch}`, '-f', `action=${action}`,
  ], { cwd: REPO, encoding: 'utf8', timeout: 30e3 });
  if (dispatch.status !== 0) {
    console.error(`[run] WARN gh workflow run dispatch failed: ${String(dispatch.stderr || '').slice(0, 200)}`);
    return { dispatched: false, runId: null };
  }
  // Bounded one-time lookup for the run's own id (NOT a polling loop — see
  // CLAUDE.md's gh-polling guidance). The run may take a moment to appear.
  let runId = null;
  for (let i = 0; i < 5 && !runId; i++) {
    if (i > 0) spawnSync('sleep', ['3']);
    const list = spawnSync('gh', [
      'run', 'list', '--workflow=autonomous-merge.yml', '--limit', '1',
      '--json', 'databaseId,status', '--jq', '.[0].databaseId',
    ], { cwd: REPO, encoding: 'utf8', timeout: 15e3 });
    const id = (list.stdout || '').trim();
    if (/^\d+$/.test(id)) runId = id;
  }
  if (!runId) { console.error('[run] WARN could not resolve autonomous-merge.yml run id after dispatch'); return { dispatched: true, runId: null }; }
  const wait = spawnSync('bash', [path.join(__dirname, 'lib', 'wait-for-run.sh'), runId, String(timeoutMin)], { cwd: REPO, encoding: 'utf8', timeout: (timeoutMin + 2) * 60e3 });
  console.error(`[run] merge run ${runId} finished with wait-for-run exit ${wait.status}`);
  return { dispatched: true, runId };
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
  steps.push(`diff gate: ${item.tier === 3 ? 'isCodeDiffAllowed' : 'isDiffAllowed'}(git diff --name-only) — card text is untrusted, gate runs regardless`);
  steps.push(`push branch + Auto → needs-approval → morning email item`);
  state = transition(state, 'run.pass').next;
  return { item, admitted: true, state, steps, spentUSD: env.estUSD, reservedUSD: worstCase };
}

function dryRun(args, cfg) {
  const nightUSD = num(args['night-budget'], cfg.nightUSD ?? 5);
  const maxItems = num(args['max-items'], cfg.maxItems ?? 3);
  let queue;
  try { queue = readQueue(args, { allowStale: true }); }
  catch (err) { console.error(`[run] ${err.message}`); process.exit(1); }

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

// Throws (never process.exit) so a caller inside live()'s try/finally still
// reaches the finally — a missing/stale queue must still release the
// singleton and send tonight's email, not go silent (ship-check P0: the old
// process.exit(1) here bypassed both). dryRun() has no such invariant and
// exits itself at its call site.
function readQueue(args, { allowStale = false } = {}) {
  const queuePath = args.queue ? path.resolve(String(args.queue)) : QUEUE_PATH;
  if (!fs.existsSync(queuePath)) {
    throw new Error(`no queue at ${queuePath} — run: node scripts/autonomous-triage.js`);
  }
  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  const ageH = (Date.now() - new Date(queue.generatedAt).getTime()) / 3600e3;
  if (!allowStale && !(ageH < QUEUE_MAX_AGE_H)) {
    throw new Error(`queue is ${ageH.toFixed(1)}h old (max ${QUEUE_MAX_AGE_H}h) — re-run triage first`);
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

// Checks execute implementer-AUTHORED code — the secret-free, fake-HOME env
// they run under is checksEnv() from scripts/lib/autonomous-checks.js, the
// ONE definition shared with the CI approve tap (S2-T1/S2-T2). It used to be
// defined here AND in autonomous-merge.js; two copies of a security-critical
// env are two things to keep in sync, and the tap's copy is the one a human
// approval leans on.

function runImplementer(item, card, workdir, model, maxWallMin, mockScript, promptPrefix, fullPromptOverride) {
  const t0 = Date.now();
  if (mockScript) {
    const r = spawnSync('node', [path.resolve(String(mockScript))], {
      cwd: workdir, encoding: 'utf8', timeout: maxWallMin * 60e3,
      env: { ...implementerEnv(), CARD_JSON: JSON.stringify({ ...item, notes: card.notes || '' }) },
    });
    if (r.status !== 0) return { ok: false, stage: 'implementer-error', error: `mock exited ${r.status}: ${String(r.stderr || '').slice(0, 200)}`, usd: 0, tokensIn: 0, tokensOut: 0, wallMin: (Date.now() - t0) / 60e3 };
    return { ok: true, usd: 0, tokensIn: 0, tokensOut: 0, resultText: String(r.stdout || '').trim().slice(0, 500) || 'mock implementer ran', wallMin: (Date.now() - t0) / 60e3 };
  }

  // promptPrefix (Sprint 3, L cards): resume/first-night checkpoint note,
  // prepended ahead of the normal card prompt — see scripts/lib/autonomous-checkpoint.js.
  // fullPromptOverride (Sprint 4, Tier-2 data cards): a complete, already-built
  // prompt (buildDataImplementerPrompt) — Tier-1's buildImplementerPrompt call
  // below is skipped entirely rather than layered under it.
  const prompt = fullPromptOverride || ((promptPrefix ? `${promptPrefix}\n\n---\n\n` : '') + buildImplementerPrompt(card, item, { tier: item.tier === 3 ? 3 : 1 }));
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

// Auth pre-flight (night-1 fix #3): one cheap ping through the same claude
// CLI + env the implementer will use. An overnight OAuth expiry otherwise
// surfaces as N per-card implementer failures; this makes it ONE explicit
// run-skip ledger line the email can report. Retries once on infra flake —
// a transient network blip must not skip a whole night — but an auth verdict
// is final (it won't heal on retry).
function preflightAuth() {
  const model = pickModel(1, null);
  let verdict = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = spawnSync('claude', [
      '-p', 'Reply with exactly: pong',
      '--model', model,
      '--output-format', 'json',
    ], { cwd: REPO, encoding: 'utf8', timeout: 90e3, maxBuffer: 4 * 1024 * 1024, env: implementerEnv() });
    verdict = preflightVerdict({ error: r.error, status: r.status, stdout: r.stdout, stderr: r.stderr });
    if (verdict.ok || verdict.kind === 'auth') return verdict;
    console.error(`[run] preflight attempt ${attempt} failed (${verdict.kind}): ${verdict.detail}`);
  }
  return verdict;
}

// Morning email (night-2 fix): previously only autonomous-nightly.sh (the
// launchd wrapper) invoked scripts/autonomous-email.js, so a manual/ad-hoc
// `--live` run — including a 0-item night — finished silently with no
// breakdown email. Sending it from inside live()'s `finally` means every
// --live invocation gets it, scheduled or not, success or throttled/skipped,
// matching autonomous-nightly.sh's old "every stage failure still advances
// to the email" invariant without depending on the shell wrapper.
// `mockEmailScript` (test-only, mirrors --mock-implementer) runs a local
// script instead of hitting Resend.
function sendMorningEmail(cfg, mockEmailScript) {
  const ownerEmail = resolveOwnerEmail(cfg, process.env);
  if (!ownerEmail) {
    console.error('[run] WARN no ownerEmail (config) or OWNER_EMAIL (.env) — skipping morning email');
    return;
  }
  const scriptPath = mockEmailScript ? path.resolve(String(mockEmailScript)) : path.join(__dirname, 'autonomous-email.js');
  try {
    execFileSync('node', [scriptPath, '--send-to', ownerEmail], { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'], env: process.env });
    console.error(`[run] morning email step done (${ownerEmail})`);
  } catch (err) {
    console.error(`[run] WARN morning email step failed: ${String(err.message || err).slice(0, 200)}`);
  }
}

// The executor half of the shared gauntlet (S2-T2). Identical plan + env +
// runner as the CI approve tap; the only difference is WHERE it runs (this
// night's worktree vs the rebased CI checkout) and that the executor also
// fills the worktree's gitignored gaps (node_modules + core-data symlinks) —
// a fresh `git worktree add` has neither, so tsc/lint/build would otherwise
// fail on environment rather than on merit.
function runChecks(workdir, changedFiles, checkableDone, tier = 1, cfg = {}) {
  return runSafeChecks({
    cwd: workdir,
    changedFiles,
    checkableDone,
    isSafeCheckCommand,
    tier,
    buildCheck: cfg.tier3BuildCheck !== false,
    prepareFrom: REPO,
  });
}

// The claim step below flips the card's Notion Status to "In progress",
// which notion-tasks-sync.js mirrors into the shared task list as in_progress
// — and a pull deliberately never downgrades in_progress→pending (that's
// what protects a live human's claim from being un-claimed underneath them,
// see notion-tasks-sync.js mergeStatus). But that same protection fires
// against the autonomous loop's OWN claim-then-fail cycle: when a card
// fails, fail() reverts Status to "Not started" so a human can retry it, but
// the mirrored task stays in_progress forever with no other release path —
// autonomous-triage-core.js's findClaimedTask() then treats the card as
// claimed in-flight permanently, so a cleared Auto never actually re-queues
// it (card #171 follow-on, 2026-07-14: this is what silently blocked the
// lint-violator card from retrying after Auto=failed was cleared). Mirrors
// the same identity read findClaimedTask uses (.notion-map.json → task file,
// [notion:<cardId>] marker) rather than trusting the numeric id alone, since
// that id namespace is shared with live sessions and can be reused.
function releaseStaleTaskClaim(cardId) {
  const dir = path.join(os.homedir(), '.claude', 'tasks', process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore');
  let notionMap;
  try { notionMap = JSON.parse(fs.readFileSync(path.join(dir, '.notion-map.json'), 'utf8')); } catch { return; }
  const entry = notionMap[cardId];
  if (!entry || !entry.taskId) return;
  const taskPath = path.join(dir, `${entry.taskId}.json`);
  let task;
  try { task = JSON.parse(fs.readFileSync(taskPath, 'utf8')); } catch { return; }
  if (task.status !== 'in_progress') return;
  if (typeof task.description !== 'string' || !task.description.includes(`[notion:${cardId}]`)) return;
  task.status = 'pending';
  try {
    const tmp = `${taskPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
    fs.renameSync(tmp, taskPath);
    console.error(`[run] released stale shared-task claim (#${entry.taskId}) for ${cardId} so it can be re-triaged`);
  } catch (e) { console.error(`[run] WARN could not release stale task claim for ${cardId}: ${e.message.slice(0, 120)}`); }
}

// async only for the UI screenshot capture (S2-T6) — every other step
// is synchronous by design (one card at a time, no interleaving).
async function attemptCard(item, budget, cfg, runId, opts) {
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
  const incremental = isIncrementalSize(item.size); // Sprint 3, S3-T4
  let resuming = false;
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
      // Only release the shared-task claim once Notion itself confirms the
      // revert (ship-check finding): releasing unconditionally would let a
      // failed notionUpdate leave Notion showing "In progress"/attempted
      // while the shared task goes pending — a second session could then
      // pick up a card Notion still says is claimed.
      releaseStaleTaskClaim(item.id);
    } catch (e) { console.error(`[run] WARN could not flip ${item.id} to failed: ${e.message.slice(0, 120)}`); }
    // totalUSD (not usd): spend is ledgered on the per-attempt implement
    // lines — a terminal line carrying usd would double-count the night.
    ledger.appendEntry({ event: 'card-fail', runId, cardId: item.id, name: item.name, contentHash: computeContentHash(card), totalUSD: round2(totalUSD), note: `${stage}: ${String(reason).slice(0, 300)}` });
    console.error(`[run] FAIL ${item.name} [${stage}] ${reason}`);
  };

  try {
    git(REPO, ['fetch', 'origin', 'main']);
    // NEVER delete a pre-existing branch or workdir — it may belong to a
    // previous pending attempt or a live interactive session (ship-check P0;
    // same refusal pattern as auto-fix-friction-card.js branchExists).
    // EXCEPTION (Sprint 3, S3-T4): an incremental (L) card's own checkpoint
    // branch from a prior night is EXPECTED to already exist on origin — that
    // is the resume signal, not a collision. Only L cards get this carve-out.
    let remoteBranch = '';
    try { remoteBranch = git(REPO, ['ls-remote', '--heads', 'origin', branch]).trim(); } catch { /* treat as absent */ }
    if (remoteBranch && !incremental) {
      budget.settle(item.id, 0);
      fail('branch-error', `branch ${branch} already exists on origin (pending previous attempt?) — refusing to overwrite`);
      return;
    }
    if (fs.existsSync(workdir)) {
      budget.settle(item.id, 0);
      fail('branch-error', `workdir ${workdir} already exists (another session?) — refusing to remove it`);
      return;
    }
    if (remoteBranch && incremental) {
      resuming = true;
      git(REPO, ['fetch', 'origin', branch]);
      git(REPO, ['worktree', 'add', workdir, branch]);
      try { git(workdir, ['rebase', 'origin/main']); }
      catch (err) {
        try { git(workdir, ['rebase', '--abort']); } catch { /* nothing to abort */ }
        try { git(REPO, ['worktree', 'remove', '--force', workdir]); } catch { /* best effort */ }
        budget.settle(item.id, 0);
        fail('branch-error', `checkpoint branch ${branch} would not rebase cleanly onto origin/main: ${err.message.slice(0, 150)}`);
        return;
      }
    } else {
      git(REPO, ['worktree', 'add', '-B', branch, workdir, 'origin/main']);
    }
  } catch (err) {
    budget.settle(item.id, 0);
    fail('branch-error', err.message.slice(0, 200));
    return;
  }

  // Incremental (L) cards get exactly ONE attempt per night — the checkpoint
  // IS the retry, next night, not a same-night Opus escalation (S3-T4).
  const maxAttempts = incremental ? 1 : 2;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt === 2) {
        // Retry starts clean — attempt 1's bad diff must not contaminate it.
        git(workdir, ['reset', '--hard', 'origin/main']);
        git(workdir, ['clean', '-fd']);
      }
      const model = pickModel(attempt, failureKind, { incremental, tier3Size: item.tier === 3 ? item.size : null });
      console.error(`[run] ${item.name}: attempt ${attempt} (${opts.mockScript ? 'mock' : model}${resuming ? ', resuming checkpoint' : ''})`);
      const promptPrefix = incremental ? (resuming ? buildResumeNote(card, card.outcome) : buildFirstNightNote()) : null;
      const imp = runImplementer(item, card, workdir, model, env.maxWallMin, opts.mockScript, promptPrefix);
      totalUSD = round2(totalUSD + imp.usd);
      ledger.appendEntry({
        event: 'implement', runId, cardId: item.id, name: item.name, attempt,
        model: opts.mockScript ? 'mock' : model, usd: imp.usd, tokensIn: imp.tokensIn, tokensOut: imp.tokensOut,
        note: imp.ok ? `ok in ${imp.wallMin.toFixed(1)}min` : `${imp.stage}: ${String(imp.error).slice(0, 200)}`,
      });

      let stage = null, detail = null, evidence = null, checkpoint = null;
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
            // Tier-aware gate: code cards (triaged under tier 3) use the
            // tier-3 predicate; everything else keeps the tight Tier-1 gate.
            const gate = item.tier === 3 ? isCodeDiffAllowed(files) : isDiffAllowed(files);
            if (!gate.allowed) { stage = 'diff-refused'; detail = `ineligible paths (tier ${item.tier === 3 ? 3 : 1}): ${gate.refused.join(', ')}`; }
            else {
              const checks = runChecks(workdir, files, item.checkableDone, tierOf(item), cfg);
              const failed = checks.filter(c => !c.pass);
              const outcome = incremental ? classifyLCardOutcome(checks, { hasCheckableDone: !!item.checkableDone }) : null;
              if (!failed.length && outcome !== 'checkpoint') {
                // tier + sha travel WITH the evidence (S2-T3/S2-T5): the CI
                // merge path is a different machine days later — it needs to
                // know which gate to apply and which commit the owner's tap
                // actually approved.
                evidence = {
                  branch, files,
                  checks: checks.map(c => `${c.name}: PASS`),
                  summary: (imp.resultText || '').slice(0, 600),
                  checkableDone: item.checkableDone || null,
                  // Surfaced so the owner's approval email can say the proof
                  // was a test THIS run authored, not a pre-existing one
                  // (ship-check: otherwise a self-graded green looks identical
                  // to a green against established coverage).
                  newCheckPaths: (item.newCheckPaths && item.newCheckPaths.length) ? item.newCheckPaths : null,
                  tier: tierOf(item),
                  sha: git(workdir, ['rev-parse', 'HEAD']).trim(),
                  ui: isUiDiff(files),
                };
              } else if (incremental && outcome === 'checkpoint') {
                // Safe, incomplete progress — nothing broke, the card just
                // isn't done yet (or has no way to prove it is). NOT a failure (S3-T4).
                checkpoint = { branch, files, summary: (imp.resultText || '').slice(0, 600) };
              } else {
                stage = 'checks-failed'; detail = failed.map(c => `${c.name}: ${c.detail}`).join(' | ').slice(0, 500);
              }
            }
          }
        } catch (err) { stage = 'git-error'; detail = err.message.slice(0, 200); }
      }

      if (evidence || checkpoint) {
        // A resumed checkpoint branch was rebased onto origin/main above,
        // rewriting its history — the remote tip needs --force-with-lease.
        // A brand-new branch (first push) uses a plain push.
        try {
          if (resuming) git(workdir, ['push', '--force-with-lease', '-u', 'origin', branch]);
          else git(workdir, ['push', '-u', 'origin', branch]);
        } catch (err) { stage = 'push-error'; detail = err.message.slice(0, 200); evidence = null; checkpoint = null; }
      }

      if (evidence) {
        if (attempt === 1) budget.refundAttempt2(item.id, item.size); // carry-forward #3
        // UI evidence (S2-T6): a diff that changes how the site LOOKS needs
        // pictures, not just green checks. Failure here is never fatal — the
        // item ships WITHOUT an approve link instead (autonomous-email-render
        // renderItem), which is the whole point: never a silent downgrade to
        // "checks passed" on something a human has to see.
        if (evidence.ui) {
          const outDir = path.join(REPO, 'data', 'audit', 'autonomous-ui', branch.replace(/[^a-z0-9]+/gi, '-'));
          try {
            const shot = await captureUiScreenshots({ workdir, outDir });
            if (shot.ok) {
              evidence.screenshots = shot.files.map(f => path.relative(REPO, f));
              console.error(`[run] captured ${shot.files.length} UI screenshot(s) for ${item.name}`);
            } else {
              console.error(`[run] WARN UI screenshot capture failed for ${item.name} (${shot.error}) — the email will withhold the approve link`);
            }
          } catch (err) {
            console.error(`[run] WARN UI screenshot capture threw for ${item.name}: ${String(err.message).slice(0, 200)}`);
          }
        }
        // Durable evidence for the CI merge path (Sprint 3) — the ledger is
        // Mac-local and unreachable from GitHub Actions.
        postEvidenceComment(item.id, evidence);
        if (isAutoMergeable(item, evidence.files)) {
          // Mechanical file-path predicate, not a model judgment call — see
          // scripts/lib/autonomous-eligibility.js isDiffDeterministicGreen.
          // isAutoMergeable additionally keeps the owner's tap on any card
          // whose proof command names a test the implementer itself wrote
          // (newCheckPaths) — see scripts/lib/autonomous-run-core.js.
          transition('attempted', 'run.auto-approve');
          notionUpdate(item.id, ['--auto', 'approved']);
          ledger.appendEntry({ event: 'auto-approve', runId, cardId: item.id, name: item.name, contentHash: computeContentHash(card), totalUSD: round2(totalUSD), note: 'deterministic-green diff — skipping human tap' });
          const merge = dispatchAndWaitMerge(item.id, branch, 'approve', 15);
          let finalCard = null;
          try { finalCard = notionBrain(['get', item.id]); } catch { /* leave finalCard null */ }
          if (finalCard && finalCard.auto === 'merged') {
            ledger.appendEntry({ event: 'auto-merge', runId, cardId: item.id, name: item.name, totalUSD: round2(totalUSD), note: `merged via autonomous-merge.yml (run ${merge.runId || '?'})` });
            console.error(`[run] AUTO-MERGED ${item.name} → ${branch}`);
          } else {
            ledger.appendEntry({ event: 'auto-merge-pending', runId, cardId: item.id, name: item.name, totalUSD: round2(totalUSD), note: `merge not confirmed (card auto=${finalCard ? finalCard.auto : 'unknown'}, run ${merge.runId || '?'})` });
            console.error(`[run] auto-merge NOT confirmed for ${item.name} (auto=${finalCard ? finalCard.auto : 'unknown'})`);
          }
        } else {
          transition('attempted', 'run.pass');
          notionUpdate(item.id, ['--auto', 'needs-approval']);
          ledger.appendEntry({ event: 'card-pass', runId, cardId: item.id, name: item.name, contentHash: computeContentHash(card), totalUSD: round2(totalUSD), attempt, evidence });
          console.error(`[run] PASS ${item.name} → ${branch} ($${totalUSD.toFixed(2)})`);
        }
        return;
      }

      if (checkpoint) {
        const night = nightNumberFor(card.outcome);
        const note = buildCheckpointNote({ night, summary: checkpoint.summary, branch });
        // Auto → clear (not 'queued' directly): triage skips any card whose
        // Auto is already set, so clearing is what lets tomorrow's triage
        // re-evaluate and re-plan this card — same pattern as crash recovery.
        try { notionUpdate(item.id, ['--auto', 'clear', '--status', 'Not started', '--outcome', note]); }
        catch (e) { console.error(`[run] WARN could not write checkpoint note for ${item.id}: ${e.message.slice(0, 120)}`); }
        ledger.appendEntry({ event: 'checkpoint', runId, cardId: item.id, name: item.name, totalUSD: round2(totalUSD), attempt, note: `night ${night}: ${checkpoint.summary.slice(0, 200)}` });
        console.error(`[run] CHECKPOINT ${item.name} → ${branch} (night ${night}, $${totalUSD.toFixed(2)})`);
        return;
      }

      failureKind = classifyFailure(stage);
      const cutOff = budget.shouldAbort(item.size, { attemptUSD: totalUSD });
      if (attempt === maxAttempts || stage === 'budget' || cutOff.abort) { fail(stage, detail); return; }
      console.error(`[run] attempt 1 failed [${stage}] (${failureKind}) — retrying${failureKind === 'content' ? ' on Opus' : ''}`);
    }
  } finally {
    budget.settle(item.id, totalUSD);
    try { git(REPO, ['worktree', 'remove', '--force', workdir]); } catch { /* leave for manual GC */ }
  }
}

// ── Tier-2 data-card executor (Sprint 4) ────────────────────────────────────
//
// Mirrors attemptCard()'s claim → branch → implement → verify → push shape,
// but branches in the PRIVATE data repo the card's class touches (never this
// repo's worktree) and verifies with the deterministic commands from
// scripts/lib/autonomous-data-verify.js instead of checkableDone (Tier-2 has
// no LLM-authored check — the class is a controlled enum, we choose the
// verifier). isDiffDeterministicGreen never matches a data-repo path, so
// every Tier-2 pass lands on needs-approval — no auto-merge branch here.
// Single attempt only (no Opus retry escalation yet — carry-forward).
function attemptDataCard(item, budget, cfg, runId) {
  let card;
  try { card = notionBrain(['get', item.id]); }
  catch (err) {
    ledger.appendEntry({ event: 'card-skip', runId, cardId: item.id, name: item.name, note: `fetch failed: ${err.message.slice(0, 120)}` });
    return;
  }
  if (card.status !== 'Not started' || card.auto) {
    ledger.appendEntry({ event: 'card-skip', runId, cardId: item.id, name: item.name, note: `state moved underneath us (status=${card.status}, auto=${card.auto || 'none'})` });
    console.error(`[run] skip ${item.name}: claimed elsewhere (status=${card.status}, auto=${card.auto || 'none'})`);
    return;
  }

  // Re-derive from the FRESH card, not the stale triage-time snapshot in
  // item — the card is untrusted and may have changed (retagged, retitled)
  // between last night's triage and tonight's attempt.
  const cls = classifyDataCard(card);
  const repoKey = cls && DATA_CLASS_REPO[cls];
  if (!cls || !repoKey) {
    ledger.appendEntry({ event: 'card-skip', runId, cardId: item.id, name: item.name, note: `no longer classifiable as a Tier-2 data card (was "${item.class}")` });
    return;
  }

  const adm = budget.admit(item.id, item.size);
  if (!adm.admitted) {
    console.error(`[run] skip ${item.name}: ${adm.reason}`);
    ledger.appendEntry({ event: 'card-skip', runId, cardId: item.id, name: item.name, note: adm.reason });
    return;
  }

  transition('queued', 'run.claim');
  notionUpdate(item.id, ['--status', 'In progress', '--auto', 'attempted']);
  ledger.appendEntry({ event: 'claim', runId, cardId: item.id, name: item.name });

  const branch = branchNameFor(item);
  const scratchRoot = path.join(WORKTREE_ROOT, `auto-data-${branch.split('/')[1]}`);
  const env = ENVELOPES[item.size];
  let totalUSD = 0;

  const fail = (stage, reason) => {
    transition('attempted', 'run.fail', { reason });
    try {
      notionUpdate(item.id, ['--auto', 'failed', '--status', 'Not started',
        '--outcome', `## Autonomous attempt failed (${new Date().toISOString().slice(0, 10)})\n${stage}: ${String(reason).slice(0, 400)}\n\nBranch (private repo: ${repoKey}) was not merged; the loop will not retry this card (Auto=failed) — clear Auto to re-queue it.`]);
      // Same claim-then-fail cycle as attemptCard's fail() (see
      // releaseStaleTaskClaim's header comment) — Tier-2 data cards claim
      // via the identical Status→"In progress" flip above, so they leave
      // the same permanent stale shared-task claim on failure without this.
      releaseStaleTaskClaim(item.id);
    } catch (e) { console.error(`[run] WARN could not flip ${item.id} to failed: ${e.message.slice(0, 120)}`); }
    ledger.appendEntry({ event: 'card-fail', runId, cardId: item.id, name: item.name, contentHash: computeContentHash(card), totalUSD: round2(totalUSD), note: `${stage}: ${String(reason).slice(0, 300)}` });
    console.error(`[run] FAIL ${item.name} [${stage}] ${reason}`);
  };

  // Collision guards (ship-check finding): Tier-1's attemptCard() refuses a
  // pre-existing workdir or remote branch before ever creating a worktree
  // (protects a live interactive session or a stranded prior attempt from
  // being clobbered) — Tier-2 had neither check, and `git worktree add -B`
  // would silently reset an existing branch to origin/main, discarding any
  // unpushed work on it.
  const privateRepoRoot = repoKey === 'scorecard-data' ? scorecardDataRoot() : reviewTextsRoot(REPO);
  let wd = null;
  try {
    if (fs.existsSync(scratchRoot)) {
      budget.settle(item.id, 0);
      fail('branch-error', `scratch dir ${scratchRoot} already exists (another attempt in flight?) — refusing to remove it`);
      return;
    }
    let remoteBranch = '';
    try { remoteBranch = git(privateRepoRoot, ['ls-remote', '--heads', 'origin', branch]).trim(); } catch { /* treat as absent */ }
    if (remoteBranch) {
      budget.settle(item.id, 0);
      fail('branch-error', `branch ${branch} already exists on ${repoKey}'s origin (pending previous attempt?) — refusing to overwrite`);
      return;
    }
    wd = buildDataWorkdir({ repoKey, branch, scratchRoot, repoRoot: REPO });
  } catch (err) {
    budget.settle(item.id, 0);
    fail('branch-error', err.message.slice(0, 300));
    return;
  }

  try {
    const model = pickModel(1, null, { dataClass: cls });
    const prompt = buildDataImplementerPrompt(card, item, { repoKey, dataClass: cls });
    console.error(`[run] ${item.name}: attempt 1 (${model}, data-class ${cls} → ${repoKey})`);
    const imp = runImplementer(item, card, wd.dataDir, model, env.maxWallMin, null, null, prompt);
    totalUSD = round2(totalUSD + imp.usd);
    ledger.appendEntry({
      event: 'implement', runId, cardId: item.id, name: item.name, attempt: 1, model,
      usd: imp.usd, tokensIn: imp.tokensIn, tokensOut: imp.tokensOut,
      note: imp.ok ? `ok in ${imp.wallMin.toFixed(1)}min` : `${imp.stage}: ${String(imp.error).slice(0, 200)}`,
    });

    let stage = null, detail = null, evidence = null;
    if (!imp.ok) { stage = imp.stage; detail = imp.error; }
    else {
      const cut = budget.shouldAbort(item.size, { elapsedMin: imp.wallMin, attemptUSD: imp.usd });
      if (cut.abort) { stage = 'budget'; detail = cut.reason; }
    }

    if (!stage) {
      const wt = primaryWorktree(wd);
      try {
        if (git(wt.path, ['status', '--porcelain']).trim()) {
          git(wt.path, ['add', '-A']);
          git(wt.path, ['commit', '-q', '-m', `auto: ${item.name} (executor commit)`]);
        }
        const files = git(wt.path, ['diff', '--name-only', 'origin/main...HEAD']).trim().split('\n').filter(Boolean);
        if (!files.length) { stage = 'empty-diff'; detail = 'implementer produced no changes'; }
        else {
          const gate = isDataRepoDiffAllowed(repoKey, files);
          if (!gate.allowed) { stage = 'diff-refused'; detail = `ineligible paths in ${repoKey}: ${gate.refused.join(', ')}`; }
          else {
            const showIds = repoKey === 'review-texts' ? showIdsFromReviewTextsDiff(files) : [];
            const verifiers = verifierArgvFor(cls, { dataDir: wd.dataDir, showIds });
            if (!verifiers.length) { stage = 'no-verifier'; detail = `class "${cls}" has no verifier command for this diff (showIds: ${showIds.join(', ') || 'none'})`; }
            else {
              const checkEnv = checksEnv();
              // cwd MUST be the scratch root (data/'s parent), never REPO:
              // verify-review-recovery.js resolves data/review-texts +
              // data/reviews.json from process.cwd() by design (its own
              // header comment) — cwd:REPO would silently re-verify the LIVE
              // main checkout instead of this candidate branch (ship-check
              // finding). validate-show-venue.js is unaffected (it takes an
              // explicit --data-dir=wd.dataDir from verifierArgvFor and
              // ignores cwd), but scratchRoot is correct for both.
              const results = verifiers.map(v => {
                try {
                  execFileSync(v.argv[0], v.argv.slice(1), { cwd: wd.scratchRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: CHECK_TIMEOUT_MS, encoding: 'utf8', env: checkEnv });
                  return { name: v.name, pass: true };
                } catch (err) {
                  return { name: v.name, pass: false, detail: String(err.stderr || err.stdout || err.message).slice(0, 400) };
                }
              });
              const failed = results.filter(r => !r.pass);
              if (failed.length) { stage = 'checks-failed'; detail = failed.map(r => `${r.name}: ${r.detail}`).join(' | ').slice(0, 500); }
              else evidence = { branch, files, checks: results.map(r => `${r.name}: PASS`), summary: (imp.resultText || '').slice(0, 600), repoKey, dataClass: cls, showIds };
            }
          }
        }
      } catch (err) { stage = 'git-error'; detail = err.message.slice(0, 200); }

      if (evidence) {
        try { pushDataBranch(wt.path, branch); }
        catch (err) { stage = 'push-error'; detail = err.message.slice(0, 200); evidence = null; }
      }
    }

    if (evidence) {
      postEvidenceComment(item.id, evidence);
      // Tier-2 diffs never touch tests/**/docs/** in THIS repo, so they can
      // never classify deterministic-green — every pass needs a human tap.
      transition('attempted', 'run.pass');
      notionUpdate(item.id, ['--auto', 'needs-approval']);
      ledger.appendEntry({ event: 'card-pass', runId, cardId: item.id, name: item.name, contentHash: computeContentHash(card), totalUSD: round2(totalUSD), attempt: 1, evidence });
      console.error(`[run] PASS ${item.name} → ${repoKey}:${branch} ($${totalUSD.toFixed(2)})`);
      return;
    }

    fail(stage, detail);
  } finally {
    budget.settle(item.id, totalUSD);
    if (wd) removeDataWorkdir(wd);
  }
}

async function live(args, cfg) {
  const mockScript = args['mock-implementer'] || null;
  const mockEmail = args['mock-email'] || null;
  const configNightUSD = num(args['night-budget'], cfg.nightUSD ?? 5);
  const maxItems = num(args['max-items'], cfg.maxItems ?? 3);
  const sizes = args.sizes ? String(args.sizes).split(',').map(s => s.trim()) : (cfg.sizes || ['S']);

  const lock = ledger.acquireSingleton();
  if (!lock.acquired) {
    // Another --live process holds the run — it (not this exit) is
    // responsible for tonight's email, so send nothing here.
    console.log(`[run] already running (pid ${lock.holder?.pid}, started ${lock.holder?.startedAt}) — exiting`);
    process.exit(0);
  }

  // Weekly clamp: a high nightly ceiling must not compound into 7x that per
  // week. Read AFTER acquiring the singleton so two near-simultaneous starts
  // can't both see the same headroom (codex ship-check). Sums the ledger's
  // `usd` fields only — terminal events (card-fail/card-pass) carry totalUSD
  // that DUPLICATES their implement rows' usd, so adding both would double-
  // count; this matches usageStats()'s week number in the morning email.
  const spent7d = ledger.sumUSD(ledger.entriesSince(ledger.readEntries().entries, new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()));
  const weekly = clampNightToWeekly(configNightUSD, cfg.weeklyUSD ?? null, spent7d);
  const nightUSD = weekly.nightUSD;
  if (weekly.clamped) console.error(`[run] ${weekly.reason}`);
  try {
    const cap = checkSharedDailyCap(nightUSD);
    // return (not process.exit): a hard exit here would skip the `finally`
    // below and, with it, tonight's morning email — a capped night should
    // still tell the owner nothing ran, not go silent.
    if (!cap.ok) { console.error(`[run] ${cap.message}`); return; }
    if (cap.warning) console.error(`[run] WARN ${cap.warning}`);


    // Missing/stale queue throws (readQueue never process.exit()s) — caught
    // here so the finally below still runs: release the lock AND send
    // tonight's email (ship-check P0 — a hard exit at this point used to
    // skip both, with the wrapper's own email step now gone too).
    let queue;
    try { queue = readQueue(args); }
    catch (err) { console.error(`[run] ${err.message}`); return; }
    // Adopt the runId triage stamped into the queue, so triage's own ledger
    // lines (its Sonnet spend) roll into this run's "Tonight" stats.
    const runId = typeof queue.runId === 'string' && /^run-/.test(queue.runId)
      ? queue.runId
      : `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    let plan = queue.plan;
    // Stale-queue tier demotion (ship-check Codex P0): plan items carry the
    // tier triage stamped, but the CONFIG at execution time is authoritative —
    // a July-24 queue with tier:3 items must not widen tonight's write scope
    // after the owner flips tier3Enabled off. Demoted items run under the
    // tight Tier-1 gate (strictly safer; src-touching diffs simply refuse).
    if (cfg.tier3Enabled !== true && plan.some(p => p.tier === 3)) {
      console.error('[run] tier3Enabled is off — demoting stale tier-3 plan items to tier 1');
      plan = plan.map(p => (p.tier === 3 ? { ...p, tier: 1 } : p));
    }
    // Tier-2 (Sprint 4): data-pipeline cards autonomous-triage.js classified
    // but Tier-1 correctly skipped for touching data/ — see buildDataPlan().
    let dataPlan = queue.dataPlan || [];
    if (args.card) {
      plan = plan.filter(p => p.id === args.card || p.id.replace(/-/g, '') === String(args.card).replace(/-/g, ''));
      dataPlan = dataPlan.filter(p => p.id === args.card || p.id.replace(/-/g, '') === String(args.card).replace(/-/g, ''));
    }

    // A partially-clamped night must be self-explanatory in the ledger (the
    // email reads it) — a $30 budget on a $60 config with no reason recorded
    // reads as a malfunction (QA review 2026-07-22).
    const clampNote = weekly.clamped ? ` · weekly-clamped from $${configNightUSD} ($${spent7d.toFixed(2)} spent in trailing 7d of $${cfg.weeklyUSD})` : '';
    ledger.appendEntry({ event: 'run-start', runId, note: `budget $${nightUSD}${clampNote} · max ${maxItems} · sizes ${sizes.join(',')} · ${plan.length} plan item(s) + ${dataPlan.length} data-plan item(s)${mockScript ? ' · MOCK implementer' : ''}` });

    // Weekly cap fully spent → skip the night gracefully (the `finally`
    // below still sends the email; the ledger explains why nothing ran).
    if (weekly.clamped && nightUSD < 1) {
      ledger.appendEntry({ event: 'run-skip', runId, note: weekly.reason });
      ledger.appendEntry({ event: 'run-end', runId, note: `skipped: weekly cap` });
      console.log(`[run] WEEKLY CAP — ${weekly.reason}. No attempts tonight.`);
      return;
    }

    // Config-vs-envelope deadlock: an enabled size whose worst-case reservation
    // exceeds even a fresh night's budget can NEVER be admitted — a night whose
    // plan is all that size burns triage spend and attempts nothing.
    // Checked against the CONFIG budget, not tonight's clamped one: a size
    // that's merely squeezed by the weekly clamp is fine config, and warning
    // "raise nightUSD or drop M" on it would tell the owner to break correct
    // settings (QA review 2026-07-22).
    const dead = inadmissibleSizes({ nightUSD: configNightUSD, sizes });
    for (const d of dead) {
      const note = `config-warning: size ${d.size} is enabled but can never be admitted — worst-case $${d.worstCaseUSD.toFixed(2)} > $${d.availableUSD.toFixed(2)} available on a fresh night. Raise nightUSD or drop ${d.size} from sizes.`;
      ledger.appendEntry({ event: 'config-warning', runId, note });
      console.error(`[run] WARNING — ${note}`);
    }

    runRecovery(new Set([...plan, ...dataPlan].map(p => p.id)), runId);

    // Approval-fatigue throttle: too many un-tapped items → no new attempts.
    const open = listCardsByAuto('needs-approval');
    if (open === null || shouldThrottle(open.length)) {
      const why = open === null ? 'could not count open approvals (failing safe)' : `${open.length} items already await approval (max 8)`;
      ledger.appendEntry({ event: 'run-end', runId, note: `throttled: ${why}` });
      console.log(`[run] THROTTLED — ${why}. No new attempts tonight.`);
      return;
    }

    // Auth pre-flight — only when there's real work and a real implementer
    // (the mock never touches claude CLI; an empty plan spends nothing).
    if ((plan.length || dataPlan.length) && !mockScript) {
      console.error('[run] preflight: pinging claude CLI (auth check)');
      const pf = preflightAuth();
      if (!pf.ok) {
        const note = pf.kind === 'auth'
          ? `auth: claude CLI login expired on Mac Studio — run skipped, no cards attempted (${pf.detail})`
          : `preflight failed: ${pf.detail} — run skipped, no cards attempted`;
        ledger.appendEntry({ event: 'run-skip', runId, note });
        ledger.appendEntry({ event: 'run-end', runId, note: `skipped: ${pf.kind}` });
        console.error(`[run] RUN SKIPPED — ${note}`);
        return;
      }
    }

    const budget = createNightBudget({ nightUSD, maxItems, sizes, weeklyUSD: cfg.weeklyUSD ?? null });
    // Tier-3 night cap (training wheels, plan v2 S2-T7). On a tier-3 night
    // EVERY plan item carries the widened scope, so this caps the whole
    // night's attempts below maxItems — deliberate first-nights conservatism
    // (ship-check QA flagged it; keeping it). The counter increments even on
    // cards that end up skipped/refused inside attemptCard — also deliberate:
    // burning a slot only makes the night MORE conservative, never less.
    // Number() (not isInteger) so a JSON-stringified "0" fails CLOSED to 0.
    const capRaw = Number(cfg.tier3MaxItems);
    const tier3Cap = Number.isFinite(capRaw) && capRaw >= 0 ? Math.floor(capRaw) : 3;
    let tier3Count = 0;
    // Spend circuit breaker (owner mandate 2026-07-30, task #635): re-checked
    // before EVERY card, reading the ledger fresh so it sees this run's own
    // just-appended spend/completions — not a one-shot check at the top of
    // the night. cfg.circuitBreakerUSD is null/unset by default (never halts)
    // until the owner opts in; see .claude/autonomous-config.json.
    const circuitBreakerUSD = Number(cfg.circuitBreakerUSD);
    const circuitBreakerThreshold = Number.isFinite(circuitBreakerUSD) && circuitBreakerUSD > 0 ? circuitBreakerUSD : null;
    let circuitTripped = false;
    function checkCircuitBreaker() {
      if (circuitTripped || circuitBreakerThreshold === null) return circuitTripped;
      const runEntries = ledger.entriesForRun(ledger.readEntries().entries, runId);
      const status = spendCircuitBreakerStatus(runEntries, { thresholdUSD: circuitBreakerThreshold });
      if (status.halt) {
        circuitTripped = true;
        ledger.appendEntry({ event: 'circuit-breaker', runId, note: status.reason });
        console.error(`[run] CIRCUIT BREAKER — ${status.reason}`);
      }
      return circuitTripped;
    }
    for (const item of plan) {
      if (checkCircuitBreaker()) {
        ledger.appendEntry({ event: 'card-skip', runId, cardId: item.id, name: item.name, note: 'spend circuit breaker tripped — night halted' });
        continue;
      }
      if (item.tier === 3) {
        if (tier3Count >= tier3Cap) {
          ledger.appendEntry({ event: 'card-skip', runId, cardId: item.id, name: item.name, note: `tier-3 night cap (${tier3Cap}) reached` });
          continue;
        }
        tier3Count++;
      }
      await attemptCard(item, budget, cfg, runId, { mockScript });
    }
    // Tier-2 items never use mockScript today (no fixture harness for the
    // data-repo path yet — carry-forward); a mock run simply attempts none.
    if (!mockScript) {
      for (const item of dataPlan) {
        if (checkCircuitBreaker()) {
          ledger.appendEntry({ event: 'card-skip', runId, cardId: item.id, name: item.name, note: 'spend circuit breaker tripped — night halted' });
          continue;
        }
        attemptDataCard(item, budget, cfg, runId);
      }
    }

    const s = budget.state();
    ledger.appendEntry({ event: 'run-end', runId, note: `spent $${s.spent.toFixed(2)} of $${nightUSD} · ${s.items} attempted` });
    console.log(`[run] night done: ${s.items} attempted · $${s.spent.toFixed(2)} spent · ledger ${ledger.LEDGER_PATH}`);
  } finally {
    ledger.releaseSingleton();
    // Always fires — success, throttle, preflight-skip, or daily-cap return
    // all reach this finally — so a manual/ad-hoc --live run gets the same
    // "night's breakdown" email a scheduled run gets (night-2 fix).
    sendMorningEmail(cfg, mockEmail);
  }
}

function num(v, dflt) {
  if (v === undefined) return dflt;
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n <= 0) { console.error(`[run] flag must be a positive number, got ${JSON.stringify(v)}`); process.exit(1); }
  return n;
}

function round2(n) { return Math.round(n * 100) / 100; }

const USAGE = `autonomous-run.js — the nightly autonomous executor.

Usage:
  node scripts/autonomous-run.js --dry-run                 plan only, ZERO writes
  node scripts/autonomous-run.js --live                     real night (claude implementer + gh dispatch)
  node scripts/autonomous-run.js --live --mock-implementer <path>   real night with a mock implementer (test only)

Options (both modes):
  --night-budget N       USD budget for the night (default from .claude/autonomous-config.json)
  --max-items N          max cards to attempt
  --sizes S,M            card sizes to admit (--live only; default from config)
  --queue <path>         override the queue file (default data/audit/autonomous-queue.json)
  --card <id>            restrict the run to one card id

  --help, -h             print this usage and exit — no claude/gh calls, no writes

Reads data/audit/autonomous-queue.json (written by scripts/autonomous-triage.js).
See the file header comment for the full claim → branch → implement → verify → push
→ needs-approval invariants.`;

// dryRunFn/liveFn are injectable so tests can prove --help never reaches
// either real path (2026-07-20 cousin fix: same incident class as
// bsc-conductor.js's 2026-07-14 --help-executes-a-real-run bug — see
// scripts/lib/cli-help.js). Checked against raw argv, not parsed flags, so
// `--live --help` / `--dry-run --help` are caught too, not just a bare
// `--help`.
function main(argv = process.argv.slice(2), dryRunFn = dryRun, liveFn = live) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const args = parseArgs(argv);
  const cfg = loadConfig();
  if (args['dry-run']) return dryRunFn(args, cfg);
  if (args.live) return liveFn(args, cfg);
  console.error('[run] pass --dry-run (plan only) or --live (real night)');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { decideChecks, tierOf, planCard, branchNameFor, attemptCard, attemptDataCard, runRecovery, readQueue, preflightAuth, sendMorningEmail, releaseStaleTaskClaim, main, USAGE };
