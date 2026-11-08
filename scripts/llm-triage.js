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
 *     [--model=ID]     default claude-sonnet-5-5
 *
 * Needs LINEAR_API_KEY. --ask needs ANTHROPIC_API_KEY. Commit search uses
 * GITHUB_TOKEN/GH_TOKEN, else the gh CLI.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const F = require('./lib/llm-triage-facts.js');

const USAGE = 'Usage: node scripts/llm-triage.js --ids=BRO-1,BRO-2 [--prompts-dir=DIR] [--ask] [--out=FILE] [--run-verify] [--model=ID]';
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const REPO = 'thomaspryor/Broadwayscore';

function parseArgs(argv) {
  const o = { ids: [], promptsDir: null, ask: false, out: null, runVerify: false, model: DEFAULT_MODEL, help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--ids=')) o.ids = a.slice(6).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--prompts-dir=')) o.promptsDir = a.slice(14);
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (a.startsWith('--model=')) o.model = a.slice(8);
    else if (a === '--ask') o.ask = true;
    else if (a === '--run-verify') o.runVerify = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  for (const id of o.ids) if (!/^BRO-\d+$/.test(id)) throw new Error(`not a card id: ${id}`);
  return o;
}

const ISSUE_FIELDS = 'id identifier title description priority url createdAt updatedAt state { name type } labels { nodes { name } } comments(first: 100, orderBy: createdAt) { nodes { body createdAt } }';

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
        try { const d = await graphql(`query { i0: issue(id: "${chunk[j]}") { ${full ? ISSUE_FIELDS : 'identifier title state { name type }'} } }`, {}); data[`i${j}`] = d && d.i0; } catch { /* unknown id */ }
      }
    }
    chunk.forEach((id, j) => { const n = data && data[`i${j}`]; if (n) out.set(id, n); });
  }
  return out;
}

/** Commits on the default branch naming the card: [{sha, date, subject}]. Empty on any failure. */
function searchCommits(id, { env = process.env } = {}) {
  const q = `repo:${REPO} "${id}"`;
  try {
    let json;
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (token) {
      json = execFileSync('curl', ['-sS', '--max-time', '30', '-G', 'https://api.github.com/search/commits', '--data-urlencode', `q=${q}`, '-H', `Authorization: Bearer ${token}`, '-H', 'Accept: application/vnd.github+json'], { encoding: 'utf8' });
    } else {
      json = execFileSync('gh', ['api', '-X', 'GET', 'search/commits', '-f', `q=${q}`], { encoding: 'utf8', timeout: 30000 });
    }
    const items = (JSON.parse(json).items) || [];
    return items.map((it) => ({ sha: it.sha, date: it.commit && it.commit.committer && it.commit.committer.date, subject: String((it.commit && it.commit.message) || '').split('\n')[0] }));
  } catch (e) {
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
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  const { finalResponseText } = require('./lib/anthropic-response-text.js');
  return finalResponseText(body.content);
}

async function main(argv = process.argv.slice(2), { graphql = null, now = new Date(), log = console.log, env = process.env, commitSearch = searchCommits, verifyRunner = null, ask = askClaude } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { log(`${e.message}\n${USAGE}`); return 2; }
  if (opts.help) { log(USAGE); return 0; }
  if (!opts.ids.length) { log(`--ids is required\n${USAGE}`); return 2; }
  if (opts.ask && !env.ANTHROPIC_API_KEY) { log('--ask needs ANTHROPIC_API_KEY'); return 2; }
  const gql = graphql || require('./lib/linear-client.js').graphql;
  const repoRoot = path.resolve(__dirname, '..');
  const nowMs = now.getTime();
  const ledger = readLedger(repoRoot);

  const bc = require('./lib/board-categories.js');
  const openBoard = await bc.fetchOpenBoard({ graphql: gql });
  const board = bc.categorizeBoard(openBoard, { now });
  const categoryOf = new Map(board.cards.map((c) => [c.identifier, c.category]));

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
  const results = [];
  for (const id of opts.ids) {
    const issue = issues.get(id);
    if (!issue) { results.push({ id, error: 'card not found' }); log(`${id}: not found`); continue; }
    const verify = F.verifyCommandOf(issue);
    const verifyResult = verify.cmd && runVerify ? await runVerify(verify.cmd) : null;
    const commits = commitSearch(id, { env });
    const facts = F.buildFacts({
      issue,
      category: categoryOf.get(id) || (issue.state && issue.state.type === 'completed' ? 'done' : 'unknown'),
      verify, verifyResult,
      commits: commits || [],
      refStates,
      overlaps: F.findOverlaps(issue, openBoard, { ledger }),
      condition: F.conditionFacts(issue, ledger),
      nowMs,
    });
    if (commits === null) facts.LANDINGS = 'unknown (commit search failed)';
    const prompt = F.renderPrompt(facts, issue);
    if (opts.promptsDir) fs.writeFileSync(path.join(opts.promptsDir, `${id}.md`), prompt);
    const row = { id, facts };
    if (opts.ask) {
      try {
        const reply = await ask(prompt, { model: opts.model, apiKey: env.ANTHROPIC_API_KEY });
        const parsed = F.parseVerdict(reply, { id, facts });
        if (parsed.ok) row.verdict = parsed.verdict; else row.error = parsed.error;
      } catch (e) { row.error = e.message; }
    }
    results.push(row);
    log(`${id}: ${row.verdict ? row.verdict.verdict : (row.error || 'prompt rendered')}`);
  }
  const report = { generatedAt: now.toISOString(), model: opts.ask ? opts.model : null, reportOnly: true, results };
  if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n');
  return results.some((r) => r.error) ? 1 : 0;
}

if (require.main === module) {
  const { exitFlushed } = require('./lib/exit-flushed.js');
  main().then((code) => exitFlushed(code), (e) => { console.error(e.stack || e.message); exitFlushed(1); });
}

module.exports = { parseArgs, fetchIssues, searchCommits, main };
