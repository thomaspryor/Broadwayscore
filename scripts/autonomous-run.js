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

const https = require('https');
const { transition } = require('./lib/autonomous-state.js');
const { isDiffAllowed, isDiffDeterministicGreen, classifyDataCard, DATA_CLASS_REPO, isDataRepoDiffAllowed } = require('./lib/autonomous-eligibility.js');
const { isSafeCheckCommand } = require('./lib/autonomous-triage-core.js');
const { createNightBudget, checkSharedDailyCap, pickModel, ENVELOPES, inadmissibleSizes } = require('./lib/autonomous-budget.js');
const ledger = require('./lib/autonomous-ledger.js');
const {
  buildImplementerPrompt, buildDataImplementerPrompt, parseClaudeJson, classifyFailure, decideChecks, cardCheckArgv, shouldThrottle, preflightVerdict,
  resolveOwnerEmail,
} = require('./lib/autonomous-run-core.js');
const { evidenceCommentText } = require('./lib/autonomous-notion-evidence.js');
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
  steps.push(`diff gate: isDiffAllowed(git diff --name-only) — card text is untrusted, gate runs regardless`);
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
  const prompt = fullPromptOverride || ((promptPrefix ? `${promptPrefix}\n\n---\n\n` : '') + buildImplementerPrompt(card, item));
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
    ledger.appendEntry({ event: 'card-fail', runId, cardId: item.id, name: item.name, totalUSD: round2(totalUSD), note: `${stage}: ${String(reason).slice(0, 300)}` });
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
      const model = pickModel(attempt, failureKind);
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
            const gate = isDiffAllowed(files);
            if (!gate.allowed) { stage = 'diff-refused'; detail = `ineligible paths: ${gate.refused.join(', ')}`; }
            else {
              const checks = runChecks(workdir, files, item.checkableDone);
              const failed = checks.filter(c => !c.pass);
              const outcome = incremental ? classifyLCardOutcome(checks, { hasCheckableDone: !!item.checkableDone }) : null;
              if (!failed.length && outcome !== 'checkpoint') {
                evidence = { branch, files, checks: checks.map(c => `${c.name}: PASS`), summary: (imp.resultText || '').slice(0, 600), checkableDone: item.checkableDone || null };
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
        // Durable evidence for the CI merge path (Sprint 3) — the ledger is
        // Mac-local and unreachable from GitHub Actions.
        postEvidenceComment(item.id, evidence);
        if (isDiffDeterministicGreen(evidence.files)) {
          // Mechanical file-path predicate, not a model judgment call — see
          // scripts/lib/autonomous-eligibility.js isDiffDeterministicGreen.
          transition('attempted', 'run.auto-approve');
          notionUpdate(item.id, ['--auto', 'approved']);
          ledger.appendEntry({ event: 'auto-approve', runId, cardId: item.id, name: item.name, totalUSD: round2(totalUSD), note: 'deterministic-green diff — skipping human tap' });
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
          ledger.appendEntry({ event: 'card-pass', runId, cardId: item.id, name: item.name, totalUSD: round2(totalUSD), attempt, evidence });
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
    ledger.appendEntry({ event: 'card-fail', runId, cardId: item.id, name: item.name, totalUSD: round2(totalUSD), note: `${stage}: ${String(reason).slice(0, 300)}` });
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
    const model = pickModel(1, null);
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
      ledger.appendEntry({ event: 'card-pass', runId, cardId: item.id, name: item.name, totalUSD: round2(totalUSD), attempt: 1, evidence });
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
  const nightUSD = num(args['night-budget'], cfg.nightUSD ?? 5);
  const maxItems = num(args['max-items'], cfg.maxItems ?? 3);
  const sizes = args.sizes ? String(args.sizes).split(',').map(s => s.trim()) : (cfg.sizes || ['S']);

  const lock = ledger.acquireSingleton();
  if (!lock.acquired) {
    // Another --live process holds the run — it (not this exit) is
    // responsible for tonight's email, so send nothing here.
    console.log(`[run] already running (pid ${lock.holder?.pid}, started ${lock.holder?.startedAt}) — exiting`);
    process.exit(0);
  }
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
    // Tier-2 (Sprint 4): data-pipeline cards autonomous-triage.js classified
    // but Tier-1 correctly skipped for touching data/ — see buildDataPlan().
    let dataPlan = queue.dataPlan || [];
    if (args.card) {
      plan = plan.filter(p => p.id === args.card || p.id.replace(/-/g, '') === String(args.card).replace(/-/g, ''));
      dataPlan = dataPlan.filter(p => p.id === args.card || p.id.replace(/-/g, '') === String(args.card).replace(/-/g, ''));
    }

    ledger.appendEntry({ event: 'run-start', runId, note: `budget $${nightUSD} · max ${maxItems} · sizes ${sizes.join(',')} · ${plan.length} plan item(s) + ${dataPlan.length} data-plan item(s)${mockScript ? ' · MOCK implementer' : ''}` });

    // Config-vs-envelope deadlock: an enabled size whose worst-case reservation
    // exceeds even a fresh night's budget can NEVER be admitted — a night whose
    // plan is all that size burns triage spend and attempts nothing.
    const dead = inadmissibleSizes({ nightUSD, sizes });
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
    for (const item of plan) attemptCard(item, budget, cfg, runId, { mockScript });
    // Tier-2 items never use mockScript today (no fixture harness for the
    // data-repo path yet — carry-forward); a mock run simply attempts none.
    if (!mockScript) for (const item of dataPlan) attemptDataCard(item, budget, cfg, runId);

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if (args['dry-run']) return dryRun(args, cfg);
  if (args.live) return live(args, cfg);
  console.error('[run] pass --dry-run (plan only) or --live (real night)');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { planCard, branchNameFor, attemptCard, attemptDataCard, runRecovery, readQueue, preflightAuth, sendMorningEmail, releaseStaleTaskClaim };
