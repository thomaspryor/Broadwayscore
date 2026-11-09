#!/usr/bin/env node
'use strict';
/**
 * llm-triage.js — report-only LLM triage of stuck board cards (BRO-7139 Step 3).
 *
 * For each card: gather FACTS by machine (scripts/lib/llm-triage-facts.js),
 * render prompt v2 (scripts/lib/llm-triage-prompt.md), and, with --ask, get a
 * verdict from Claude. Writes a JSON report. NEVER writes Linear: verdicts are
 * nominations; a later step (after the >= 90% re-score gate) decides what acts.
 *
 * Usage:
 *   node scripts/llm-triage.js --ids=BRO-1,BRO-2 [--prompts-dir=DIR] [--ask] [--out=FILE]
 *     [--run-verify]   run each card's VERIFY on a fresh origin/main checkout (slow)
 *     [--model=ID]     default models.js DISPATCH_SONNET
 *
 * Needs LINEAR_API_KEY. --ask needs ANTHROPIC_API_KEY. Commit search uses
 * GITHUB_TOKEN/GH_TOKEN, else the gh CLI. --run-verify fetches origin and makes a
 * temporary local worktree (no Linear or remote writes).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const F = require('./lib/llm-triage-facts.js');
const Q = require('./lib/llm-triage-queue.js');

const USAGE = 'Usage: node scripts/llm-triage.js (--ids=BRO-1,BRO-2 | --queue [--cap=N]) [--ledger=FILE] [--deadline-min=N] [--prompts-dir=DIR] [--ask] [--out=FILE] [--run-verify] [--model=ID]';
const DEFAULT_MODEL = require('./lib/models.js').DISPATCH_SONNET;
const REPO = 'thomaspryor/Broadwayscore';
const ASK_TIMEOUT_MS = 90000;

function parseArgs(argv) {
  const o = { ids: [], promptsDir: null, ask: false, out: null, runVerify: false, model: DEFAULT_MODEL, help: false, queue: false, cap: Q.CAP, ledger: null, deadlineMin: null };
  for (const a of argv) {
    if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--ids=')) o.ids = a.slice(6).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--prompts-dir=')) o.promptsDir = a.slice(14);
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (a.startsWith('--model=')) o.model = a.slice(8);
    else if (a === '--ask') o.ask = true;
    else if (a === '--run-verify') o.runVerify = true;
    else if (a === '--queue') o.queue = true;
    else if (a.startsWith('--cap=')) { o.cap = Number(a.slice(6)); if (!Number.isInteger(o.cap) || o.cap < 1 || o.cap > Q.CAP) throw new Error(`--cap must be 1..${Q.CAP}`); }
    else if (a.startsWith('--ledger=')) o.ledger = a.slice(9);
    else if (a.startsWith('--deadline-min=')) { o.deadlineMin = Number(a.slice(15)); if (!(o.deadlineMin > 0)) throw new Error('--deadline-min must be > 0'); }
    else throw new Error(`unknown argument: ${a}`);
  }
  for (const id of o.ids) if (!/^BRO-\d+$/.test(id)) throw new Error(`not a card id: ${id}`);
  if (o.queue && o.ids.length) throw new Error('--queue and --ids are exclusive');
  // A ledger row without a verdict is noise the weekly audit would have to skip.
  if (o.ledger && !o.ask) throw new Error('--ledger needs --ask');
  return o;
}

const ISSUE_FIELDS = 'id identifier title description priority url createdAt updatedAt state { name type } labels { nodes { name } } comments(first: 100, orderBy: createdAt) { nodes { body createdAt } } history(first: 50) { nodes { createdAt fromState { name type } toState { name type } } }';

/** Fetch cards by identifier in one aliased query. full=false fetches only title + state. */
async function fetchIssues(graphql, ids, { full = true } = {}) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const q = `query { ${chunk.map((id, j) => `i${j}: issue(id: "${id}") { ${full ? ISSUE_FIELDS : 'identifier title state { name type }'} }`).join(' ')} }`;
    let data;
    try { data = await graphql(q, {}); } catch (e) {
      // One missing id fails the whole aliased query; fall back to one at a time.
      data = {};
      for (let j = 0; j < chunk.length; j++) {
        try {
          const d = await graphql(`query { i0: issue(id: "${chunk[j]}") { ${full ? ISSUE_FIELDS : 'identifier title state { name type }'} } }`, {});
          data[`i${j}`] = d && d.i0;
        } catch (e1) {
          // Only "no such card" is skipped; auth, network or 5xx must not read as "card not found".
          if (!/not found|could not find|entity/i.test(String(e1 && e1.message))) throw e1;
        }
      }
    }
    chunk.forEach((id, j) => { const n = data && data[`i${j}`]; if (n) out.set(id, n); });
  }
  return out;
}

/**
 * GitHub search/commits JSON -> [{sha, date, subject}], or null when the body is
 * not a search result (a 403 rate limit or 422 returns {"message": ...}).
 * null means "unknown", never "no landings".
 */
function parseCommitSearch(json) {
  let body;
  try { body = JSON.parse(json); } catch { return null; }
  if (!body || !Array.isArray(body.items)) return null;
  return body.items.map((it) => ({ sha: it.sha, date: it.commit && it.commit.committer && it.commit.committer.date, subject: String((it.commit && it.commit.message) || '').split('\n')[0] }));
}

/** Commits on the default branch naming the card: [{sha, date, subject}]. null on any failure. */
function searchCommits(id, { env = process.env } = {}) {
  const q = `repo:${REPO} "${id}"`;
  try {
    let json;
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (token) {
      json = execFileSync('curl', ['-sS', '--fail-with-body', '--max-time', '30', '-G', 'https://api.github.com/search/commits', '--data-urlencode', `q=${q}`, '-H', `Authorization: Bearer ${token}`, '-H', 'Accept: application/vnd.github+json'], { encoding: 'utf8' });
    } else {
      json = execFileSync('gh', ['api', '-X', 'GET', 'search/commits', '-f', `q=${q}`], { encoding: 'utf8', timeout: 30000 });
    }
    return parseCommitSearch(json);
  } catch (e) {
    return null;
  }
}

/**
 * Completed runs of one workflow file, newest first: [{conclusion, created_at}], or null on
 * any failure (null reads "unknown", never "no runs").
 */
function fetchWorkflowRuns(file, { env = process.env, limit = 20 } = {}) {
  if (!/^[\w.-]+\.ya?ml$/.test(file)) return null;
  const route = `repos/${REPO}/actions/workflows/${file}/runs?status=completed&per_page=${limit}`;
  try {
    let json;
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (token) {
      json = execFileSync('curl', ['-sS', '--fail-with-body', '--max-time', '30', `https://api.github.com/${route}`, '-H', `Authorization: Bearer ${token}`, '-H', 'Accept: application/vnd.github+json'], { encoding: 'utf8' });
    } else {
      json = execFileSync('gh', ['api', route], { encoding: 'utf8', timeout: 30000 });
    }
    const body = JSON.parse(json);
    if (!body || !Array.isArray(body.workflow_runs)) return null;
    return body.workflow_runs.map((r) => ({ conclusion: r.conclusion, created_at: r.created_at }));
  } catch {
    return null;
  }
}

function readLedger(repoRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/audit/alert-ledger.json'), 'utf8')); } catch { return null; }
}

async function askClaude(prompt, { model, apiKey, fetchImpl = fetch }) {
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
    // A hung call must not eat the nightly step's whole time budget.
    signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  const { finalResponseText } = require('./lib/anthropic-response-text.js');
  return finalResponseText(body.content);
}

async function main(argv = process.argv.slice(2), { graphql = null, now = new Date(), log = console.log, env = process.env, commitSearch = searchCommits, verifyRunner = null, ask = askClaude, workflowRuns = fetchWorkflowRuns, clock = Date.now, recheckLedger = undefined } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { log(`${e.message}\n${USAGE}`); return 2; }
  if (opts.help) { log(USAGE); return 0; }
  if (env.LLM_TRIAGE_DISABLED === 'true') { log('llm-triage: disabled by LLM_TRIAGE_DISABLED'); return 0; }
  // The deadline counts from here, so the board and card fetches are inside it.
  const startedAt = clock();
  if (!opts.ids.length && !opts.queue) { log(`--ids or --queue is required\n${USAGE}`); return 2; }
  if (opts.ask && !env.ANTHROPIC_API_KEY) { log('--ask needs ANTHROPIC_API_KEY'); return 2; }
  const gql = graphql || require('./lib/linear-client.js').graphql;
  const repoRoot = path.resolve(__dirname, '..');
  const nowMs = now.getTime();
  const ledger = readLedger(repoRoot);

  const bc = require('./lib/board-categories.js');
  const openBoard = await bc.fetchOpenBoard({ graphql: gql });
  // Same inputs as board-dispatch.js, so the queue matches the board report's categories.
  const board = bc.categorizeBoard(openBoard, { now, secret: env.APPROVAL_HMAC_SECRET || null, lastRecheckStatusById: bc.readRecheckLedgerStatuses(recheckLedger) });
  const categoryOf = new Map(board.cards.map((c) => [c.identifier, c.category]));
  let ledgerText = '';
  if (opts.ledger) { try { ledgerText = fs.readFileSync(opts.ledger, 'utf8'); } catch { ledgerText = ''; } }
  if (opts.queue) {
    const q = Q.selectQueue(board, Q.parseLedger(ledgerText), { nowMs, cap: opts.cap });
    opts.ids = q.ids;
    log(`llm-triage queue: ${q.ids.length} of ${q.eligible} llm-triage cards (${q.cooling} triaged in the last ${Q.COOLDOWN_DAYS} days)`);
  }

  const issues = await fetchIssues(gql, opts.ids);
  const refIds = new Set();
  for (const issue of issues.values()) for (const r of F.referencedIds(F.cardText(issue), issue.identifier).slice(0, 8)) refIds.add(r);
  const refIssues = await fetchIssues(gql, [...refIds], { full: false });
  const refStates = new Map([...refIssues].map(([id, n]) => [id, { state: n.state && n.state.name, title: n.title }]));

  let runVerify = verifyRunner;
  if (opts.runVerify && !runVerify) {
    const { makeVerifyCmdEvidence } = require('./lib/linear-cmd-execution.js');
    runVerify = makeVerifyCmdEvidence({ repo: repoRoot, log: () => {} });
  }

  if (opts.promptsDir) fs.mkdirSync(opts.promptsDir, { recursive: true });
  const meta = { ts: now.toISOString(), source: env.GITHUB_ACTIONS === 'true' ? 'ci' : 'local', runId: env.GITHUB_RUN_ID || null, model: opts.ask ? opts.model : null };
  let needsNewline = !!(ledgerText && !ledgerText.endsWith('\n'));
  // One row per card as soon as it finishes: a step killed mid-run keeps the cards it did.
  const appendLedger = (r) => {
    if (!opts.ledger) return;
    fs.mkdirSync(path.dirname(opts.ledger), { recursive: true });
    fs.appendFileSync(opts.ledger, (needsNewline ? '\n' : '') + JSON.stringify(Q.ledgerRow(r, { ...meta, category: categoryOf.get(r.id) || null })) + '\n');
    needsNewline = false;
  };
  const stopAt = opts.deadlineMin ? startedAt + opts.deadlineMin * 60000 : Infinity;
  const results = [];
  for (const id of opts.ids) {
    if (clock() >= stopAt) { log(`llm-triage: deadline reached, ${opts.ids.length - results.length} card(s) left for the next run`); break; }
    const issue = issues.get(id);
    if (!issue) { const miss = { id, error: 'card not found' }; results.push(miss); appendLedger(miss); log(`${id}: not found`); continue; }
    let row = { id };
    try {
      const verify = F.verifyCommandOf(issue);
      const verifyResult = verify.cmd && runVerify ? await runVerify(verify.cmd) : null;
      const commits = commitSearch(id, { env });
      const runs = new Map(F.workflowFilesOf(issue, verify).map((f) => [f, workflowRuns(f, { env })]));
      const facts = F.buildFacts({
        issue,
        category: categoryOf.get(id) || (issue.state && issue.state.type === 'completed' ? 'done' : 'unknown'),
        verify, verifyResult,
        commits: commits || [],
        refStates,
        overlaps: F.findOverlaps(issue, openBoard, { ledger }),
        condition: F.conditionFacts(issue, ledger),
        nowMs,
        workflowRuns: runs,
      });
      if (commits === null) facts.LANDINGS = 'unknown (commit search failed)';
      const prompt = F.renderPrompt(facts, issue);
      if (opts.promptsDir) fs.writeFileSync(path.join(opts.promptsDir, `${id}.md`), prompt);
      row = { id, facts };
      if (opts.ask) {
        try {
          const reply = await ask(prompt, { model: opts.model, apiKey: env.ANTHROPIC_API_KEY });
          const parsed = F.parseVerdict(reply, { id, facts });
          if (parsed.ok) row.verdict = parsed.verdict; else row.error = parsed.error;
        } catch (e) { row.error = e.message; }
      }
    } catch (e) {
      // One bad card (unfilled placeholder, VERIFY runner crash) must not lose the whole report.
      row.error = `triage failed: ${e.message}`;
    }
    results.push(row);
    appendLedger(row);
    log(`${id}: ${row.verdict ? row.verdict.verdict : (row.error || 'prompt rendered')}`);
  }
  const report = { generatedAt: now.toISOString(), model: opts.ask ? opts.model : null, reportOnly: true, results };
  if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n');
  // One bad card is a ledger row, not a red night; every card failing is. A partial failure
  // still shows on the run page as a warning annotation.
  const failed = results.filter((r) => r.error).length;
  if (failed && failed < results.length && env.GITHUB_ACTIONS) log(`::warning::llm-triage: ${failed} of ${results.length} cards errored (rows in the ledger)`);
  return results.length && results.every((r) => r.error) ? 1 : 0;
}

if (require.main === module) {
  const { exitFlushed } = require('./lib/exit-flushed.js');
  main().then((code) => exitFlushed(code), (e) => { console.error(e.stack || e.message); exitFlushed(1); });
}

module.exports = { parseArgs, fetchIssues, parseCommitSearch, searchCommits, fetchWorkflowRuns, main };
