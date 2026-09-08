#!/usr/bin/env node
/**
 * audit-stale-open-premises.js — re-check the PROBLEM statement of cards that
 * are still OPEN. Report only; it never writes to Linear.
 *
 *   node scripts/audit-stale-open-premises.js --dry-run     # selection only, runs nothing
 *   node scripts/audit-stale-open-premises.js --limit=10
 *   node scripts/audit-stale-open-premises.js --filter='main red|CI red'
 *   node scripts/audit-stale-open-premises.js --help
 *
 * WHY THIS EXISTS, and why it is the mirror of an audit we already run:
 *
 * scripts/autonomous-acceptance-recheck.js was built on the observation that
 * "Done on a card is a claim by whoever closed it — nothing has ever checked
 * it afterwards". The symmetric hole was left open: a card's PROBLEM
 * statement is also just a claim, made once, by whoever filed it, and nothing
 * ever re-checks THAT. So a card filed as "main red because X fails" stays in
 * the backlog forever after somebody else fixes X in passing.
 *
 * Measured on the live board (2026-09-07): 27 open, unstarted cards asserted a
 * red or failing state while main was green and all six data gates passed, and
 * the two best-specified P1s in the dispatch funnel — BRO-2355 (a registry
 * domain collision) and BRO-2039 (a stale workflow-source assertion) — had
 * both already been fixed by other sessions. Every triage pass re-derives that
 * from scratch, one card at a time, and pays for it again next cycle.
 *
 * WHAT A PASS DOES AND DOES NOT MEAN — read this before believing the output:
 *
 * A card's acceptance criteria describe the FIXED state ("when the fix is
 * applied, Data Validation should pass"). So when an OPEN card's own command
 * PASSES against a fresh origin/main, the state the card was filed to reach is
 * already reached. That is evidence its premise is stale — it is NOT proof.
 * A command that would have passed before the fix too (a broad smoke test, a
 * command aimed at a different symptom than the title claims) passes here for
 * reasons that have nothing to do with the card. That is exactly why this
 * reports candidates with their command and title attached, for a reader to
 * judge, and never closes anything itself. Same shadow-mode contract the
 * Done-side recheck runs under, for the same reason.
 *
 * Safety properties, all inherited from scripts/lib/acceptance-check-core.js
 * rather than re-implemented (CLAUDE.md rule 15 — one implementation):
 *   - the command is UNTRUSTED text off a card, re-validated against
 *     isSafeCheckCommand at RUN time, not just at selection time;
 *   - it runs in a disposable DETACHED checkout that cannot disturb the
 *     caller's branch state, with the secret-free fake-HOME check env;
 *   - timeouts, spawn failures and exit 3 are "no verdict", never "failing" —
 *     this audit fails OPEN in every direction, because the cost of a wrong
 *     "your premise is stale" is a real bug getting closed.
 */

'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');
const { evaluateVerifiability } = require('./lib/verify-gate.js');
const {
  makeFreshCheckout,
  removeCheckout,
  runVerify,
  CHECK_TIMEOUT_MS,
} = require('./lib/acceptance-check-core.js');

const USAGE = `audit-stale-open-premises.js — re-check the PROBLEM statement of still-open cards

  --dry-run        select and report cards only; make no checkout, run no command
  --limit=N        check at most N cards (default: no limit)
  --filter=REGEX   only cards whose title matches REGEX (case-insensitive)
  --json           emit machine-readable JSON instead of the text report
  --help           this message

Report-only. Never writes to Linear, never closes a card.`;

// States that mean "nobody has started this" — the only ones worth re-checking.
// A card someone is actively working right now is skipped, not re-checked,
// matching autonomous-acceptance-recheck.js's rule for the Done side.
const UNSTARTED_STATES = /^(Todo|Backlog|Triage)$/i;

/**
 * Which open cards are worth re-checking, and with what command.
 *
 * Pure: takes already-fetched issues, returns a plan. No I/O, so the test can
 * drive every branch without a Linear round trip.
 *
 * @param {Array<{identifier:string,title:string,description:string,state:{name:string}}>} issues
 * @param {{filter?:RegExp|null, limit?:number|null}} opts
 * @returns {{selected:Array, skipped:Array}}
 */
function selectAuditableCards(issues, { filter = null, limit = null } = {}) {
  const selected = [];
  const skipped = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    const identifier = issue && issue.identifier;
    const title = String((issue && issue.title) || '');
    const state = String((issue && issue.state && issue.state.name) || '');
    if (!identifier) continue;

    if (!UNSTARTED_STATES.test(state)) {
      skipped.push({ identifier, title, state, reason: 'not-unstarted' });
      continue;
    }
    if (filter && !filter.test(title)) {
      skipped.push({ identifier, title, state, reason: 'filtered-out' });
      continue;
    }

    const verdict = evaluateVerifiability(String((issue && issue.description) || ''));
    if (!verdict.armed) {
      skipped.push({ identifier, title, state, reason: 'no-safe-command', kind: verdict.kind || null });
      continue;
    }
    // An owner-judgment card arms the DISPATCH gate without naming anything a
    // machine can run. There is nothing here to re-check.
    if (!verdict.cmd) {
      skipped.push({ identifier, title, state, reason: 'owner-judgment' });
      continue;
    }
    if (limit != null && selected.length >= limit) {
      skipped.push({ identifier, title, state, reason: 'over-limit' });
      continue;
    }
    selected.push({ identifier, title, state, cmd: verdict.cmd });
  }
  return { selected, skipped };
}

/**
 * Turn one runVerify() result into this audit's verdict.
 *
 * Pure, and deliberately narrow: the ONLY outcome that produces a
 * premise-stale candidate is an unambiguous pass. Everything else — a
 * failure, a timeout, a missing binary, exit 3 — leaves the card alone.
 *
 * @param {{status:'pass'|'fail'|'unverifiable', detail:string|null}} runResult
 * @returns {{verdict:'premise-stale-candidate'|'premise-live'|'unverifiable', detail:string|null}}
 */
function classifyPremiseOutcome(runResult) {
  const status = runResult && runResult.status;
  const detail = (runResult && runResult.detail) || null;
  if (status === 'pass') {
    return { verdict: 'premise-stale-candidate', detail };
  }
  if (status === 'fail') {
    return { verdict: 'premise-live', detail };
  }
  return { verdict: 'unverifiable', detail };
}

function parseArgs(argv) {
  const opts = { dryRun: false, limit: null, filter: null, json: false };
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length));
      if (!Number.isInteger(n) || n < 1) throw new Error(`--limit must be a positive integer, got: ${arg}`);
      opts.limit = n;
    } else if (arg.startsWith('--filter=')) {
      opts.filter = new RegExp(arg.slice('--filter='.length), 'i');
    }
  }
  return opts;
}

function report(results, skipped, opts) {
  if (opts.json) {
    console.log(JSON.stringify({ results, skippedCount: skipped.length }, null, 2));
    return;
  }
  const stale = results.filter((r) => r.verdict === 'premise-stale-candidate');
  const live = results.filter((r) => r.verdict === 'premise-live');
  const unver = results.filter((r) => r.verdict === 'unverifiable');

  console.log(`\nChecked ${results.length} open card(s); skipped ${skipped.length}.\n`);
  if (stale.length) {
    console.log(`PREMISE-STALE CANDIDATES (${stale.length}) — their own acceptance command already PASSES on origin/main.`);
    console.log('A pass is evidence, not proof: read the command against the title before closing anything.\n');
    for (const r of stale) {
      console.log(`  ${r.identifier} [${r.state}] ${r.title}`);
      console.log(`      cmd: ${r.cmd}`);
    }
    console.log('');
  }
  console.log(`Premise still live: ${live.length}   No verdict: ${unver.length}`);
  for (const r of unver) console.log(`  (no verdict) ${r.identifier}: ${r.detail || 'unknown'}`);
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log(USAGE);
    return 0;
  }
  const opts = parseArgs(process.argv.slice(2));

  // Required lazily so --help and the colocated unit test never need network,
  // credentials, or the Linear client's module-load-time config.
  const { listOpenIssuesWithDescriptions } = require('./lib/linear-client.js');
  const issues = await listOpenIssuesWithDescriptions();
  const { selected, skipped } = selectAuditableCards(issues, { filter: opts.filter, limit: opts.limit });

  console.log(`${issues.length} open issue(s); ${selected.length} carry a runnable acceptance command and are unstarted.`);

  if (opts.dryRun) {
    for (const c of selected) console.log(`  would check ${c.identifier} [${c.state}] :: ${c.cmd}`);
    console.log(`\n--dry-run: nothing was executed.`);
    return 0;
  }
  if (!selected.length) {
    console.log('Nothing to check.');
    return 0;
  }

  const checkout = makeFreshCheckout();
  const results = [];
  try {
    for (const card of selected) {
      const run = runVerify(checkout.wt, card.cmd, { timeoutMs: CHECK_TIMEOUT_MS, prepared: checkout.prepared });
      const { verdict, detail } = classifyPremiseOutcome(run);
      results.push({ ...card, verdict, detail });
      console.log(`  ${verdict.padEnd(24)} ${card.identifier}`);
    }
  } finally {
    removeCheckout(checkout);
  }

  report(results, skipped, opts);
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`audit-stale-open-premises: ${err && err.message ? err.message : err}`);
      process.exit(1);
    });
}

module.exports = { selectAuditableCards, classifyPremiseOutcome, parseArgs, UNSTARTED_STATES };
