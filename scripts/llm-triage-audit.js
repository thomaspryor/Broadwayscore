#!/usr/bin/env node
'use strict';
/**
 * llm-triage-audit.js — weekly audit of the nightly llm-triage nominations (BRO-7139 Step 3).
 *
 * Samples up to 40 nominations from data/audit/llm-triage.jsonl and re-checks each against
 * reality: the card's Linear state (archived cards included), landings on main naming it,
 * its comments, and (with --run-verify, local only) its own VERIFY on main now. Appends one
 * text-free row to data/audit/llm-triage-audit.jsonl (public repo: ids, enums, dates only).
 * Never writes Linear. Card text is only read by regexes, never sent anywhere.
 *
 *   node scripts/llm-triage-audit.js                 # print, write nothing
 *   node scripts/llm-triage-audit.js --write         # append a row (CI does this)
 *   node scripts/llm-triage-audit.js --force         # ignore the weekly throttle
 *   node scripts/llm-triage-audit.js --run-verify    # also run each card's safe VERIFY
 *
 * Runs nightly from the board-dispatch job but audits once a week: it exits 0 without a row
 * when the last CI audit that judged anything is under 6 days old. Nominations are audited
 * once they are 7 days old; ones an earlier audit settled are never re-sampled. GitHub search
 * calls are spaced 2.1s apart; past --deadline-sec (240) the rest read pending and the row is
 * still written. Kill switch: LLM_TRIAGE_AUDIT_DISABLED=true.
 */
const fs = require('fs');
const path = require('path');
const A = require('./lib/llm-triage-audit.js');
const Q = require('./lib/llm-triage-queue.js');

const FIELDS = 'identifier description completedAt canceledAt state { type } comments(first: 100) { nodes { body createdAt } pageInfo { hasNextPage } }';
const SHORT = 'identifier completedAt canceledAt state { type }';

function parseArgs(argv) {
  const o = { deadlineSec: 240, write: false, force: false, runVerify: false, includeLocal: false, ledger: 'data/audit/llm-triage.jsonl', out: A.AUDIT_LEDGER_PATH };
  for (const a of argv) {
    if (a === '--write') o.write = true;
    else if (a === '--force') o.force = true;
    else if (a === '--run-verify') o.runVerify = true;
    else if (a === '--include-local') o.includeLocal = true;
    else if (a.startsWith('--ledger=')) o.ledger = a.slice(9);
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (a.startsWith('--deadline-sec=')) o.deadlineSec = Number(a.slice(15));
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const readRows = (p) => (fs.existsSync(p) ? Q.parseLedger(fs.readFileSync(p, 'utf8')) : []);

async function fetchCards(graphql, ids, fields) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    let data = {};
    try { data = await graphql(`query { ${chunk.map((id, j) => `i${j}: issue(id: "${id}") { ${fields} }`).join(' ')} }`, {}); } catch (e) {
      for (let j = 0; j < chunk.length; j++) {
        try { data[`i${j}`] = (await graphql(`query { i0: issue(id: "${chunk[j]}") { ${fields} } }`, {})).i0; } catch (e1) {
          if (!/not found|could not find|entity/i.test(String(e1 && e1.message))) throw e1;
        }
      }
    }
    chunk.forEach((id, j) => { const n = data && data[`i${j}`]; if (n) out.set(id, n); });
  }
  return out;
}

const closedAtOf = (n) => (n && (n.completedAt || n.canceledAt)) || null;

// GitHub search allows 30 requests a minute; the triage step just before used some of it.
const SEARCH_GAP_MS = 2100;
const sleepSync = (msec) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, msec);

async function main(argv = process.argv.slice(2), { graphql = null, now = new Date(), log = console.log, env = process.env, commitSearch = null, verifyRunner = null, clock = Date.now, pause = sleepSync } = {}) {
  if (env.LLM_TRIAGE_AUDIT_DISABLED === 'true') { log('llm-triage-audit: disabled (LLM_TRIAGE_AUDIT_DISABLED=true)'); return 0; }
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  const nowMs = now.getTime();
  const source = env.GITHUB_ACTIONS === 'true' ? 'ci' : 'local';
  const prior = readRows(opts.out);
  if (!opts.force && source === 'ci' && A.auditedRecently(prior, nowMs)) { log('llm-triage-audit: audited under 6 days ago, skipping'); return 0; }

  const sample = A.sampleNominations(readRows(opts.ledger), { nowMs, includeLocal: opts.includeLocal, settled: A.settledKeys(prior) });
  const meta = { ts: now.toISOString(), source, runId: env.GITHUB_RUN_ID || null };
  const append = (row) => {
    if (!opts.write) return;
    const prev = fs.existsSync(opts.out) ? fs.readFileSync(opts.out, 'utf8') : '';
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.appendFileSync(opts.out, (prev && !prev.endsWith('\n') ? '\n' : '') + JSON.stringify(row) + '\n');
  };
  if (!sample.length) { log('llm-triage-audit: no nominations old enough to audit yet'); return 0; }

  let cards; let blockers;
  try {
    const gql = graphql || require('./lib/linear-client.js').graphql;
    cards = await fetchCards(gql, sample.map((r) => r.id), FIELDS);
    const bIds = [...new Set(sample.map((r) => r.blocked_on).filter((x) => /^BRO-\d+$/.test(String(x))))];
    blockers = await fetchCards(gql, bIds, SHORT);
  } catch (e) {
    append({ v: 1, ...meta, error: String((e && e.message) || e).split(/[:\n]/)[0].replace(/[^\w .-]/g, '').slice(0, 60) });
    console.error(`llm-triage-audit: Linear read failed: ${e.message}`);
    return 1;
  }

  const rawSearch = commitSearch || ((id) => require('./llm-triage.js').searchCommits(id, { env }));
  let searches = 0;
  const search = (id) => { if (searches++) pause(SEARCH_GAP_MS); return rawSearch(id); };
  const stopAt = clock() + opts.deadlineSec * 1000;
  let runVerify = verifyRunner;
  if (opts.runVerify && !runVerify) {
    const { makeVerifyCmdEvidence } = require('./lib/linear-cmd-execution.js');
    runVerify = makeVerifyCmdEvidence({ repo: path.resolve(__dirname, '..'), log: () => {} });
  }
  const F = require('./lib/llm-triage-facts.js');

  const items = [];
  for (const row of sample) {
    const card = cards.get(row.id);
    // Past the deadline the rest read pending, and the row is still written (a killed step writes nothing).
    if (clock() > stopAt) { items.push({ id: row.id, nominatedTs: row.ts, verdict: row.verdict, judgment: 'pending', why: 'deadline' }); continue; }
    if (!card) { items.push({ id: row.id, nominatedTs: row.ts, verdict: row.verdict, judgment: 'pending', why: 'card-missing' }); continue; }
    const out = { closedAt: closedAtOf(card), completedAt: card.completedAt || null, comments: (card.comments && card.comments.nodes) || [],
      commentsTruncated: !!(card.comments && card.comments.pageInfo && card.comments.pageInfo.hasNextPage) };
    if (row.verdict === 'close-candidate' || row.verdict === 'keep') out.landings = search(row.id);
    if (row.blocked_on) out.blockerClosedAt = blockers.has(row.blocked_on) ? closedAtOf(blockers.get(row.blocked_on)) : undefined;
    if (runVerify && (row.verdict === 'close-candidate' || row.verdict === 'recheck')) {
      const v = F.verifyCommandOf(card);
      out.verify = v.cmd ? F.verifyResultWord(await runVerify(v.cmd)) : 'not-run';
    }
    const { judgment, why } = A.judgeNomination(row, out, { nowMs });
    items.push({ id: row.id, nominatedTs: row.ts, verdict: row.verdict, judgment, why });
  }
  const row = A.auditRow(items, meta);
  append(row);
  const cum = A.cumulativeJudgments([...prior, row]);
  log(`llm-triage-audit: sampled ${row.sampled}, judged ${row.judged} (${row.scored} scored), wrong ${row.wrong}, pending ${row.pending}, wrong-rate ${row.wrongRate == null ? 'n/a' : (row.wrongRate * 100).toFixed(1) + '%'}`);
  log(`llm-triage-audit: cumulative ${cum.scored} distinct scored, wrong-rate ${cum.wrongRate == null ? 'n/a' : (cum.wrongRate * 100).toFixed(1) + '%'}`);
  for (const i of items.filter((x) => x.judgment === 'wrong')) log(`  wrong: ${i.id} ${i.verdict} (${i.why})`);
  return 0;
}

if (require.main === module) {
  const { exitFlushed } = require('./lib/exit-flushed.js');
  main().then((code) => exitFlushed(code), (e) => { console.error(e.stack || e.message); exitFlushed(1); });
}

module.exports = { parseArgs, fetchCards, main };
