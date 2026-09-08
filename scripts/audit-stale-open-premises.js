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
 * AND THE FAILING SIDE IS NOT A VERDICT ABOUT THE CARD AT ALL. The fresh
 * checkout has no private-repo data (data/review-texts, core data), so a card
 * whose command reads that data FAILS there for reasons that have nothing to
 * do with its premise. Measured on BRO-2356: its command came back failing
 * with "scanned 0 review files — data/review-texts is missing or empty", while
 * the identical command passes on a main checkout. That is why the failing
 * bucket is called `still-failing` and not `premise-live` — the tool cannot
 * tell a live premise from an unprepared checkout, and must not claim to. Only
 * the PASS side is actionable; `still-failing` means "leave this card alone",
 * which is the conservative direction either way.
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

const fs = require('fs');
const path = require('path');

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

// The corpora a fresh checkout does NOT get. prepareCheckWorkdir copies only
// top-level *.json out of data/ and public/data/; the private review-texts repo
// and the per-show/per-audit trees are simply absent.
const REQUIRED_CORPORA = ['data/review-texts', 'public/data/shows', 'data/audit'];

/**
 * Is this checkout carrying the corpora a scanning command needs?
 *
 * THIS IS THE GUARD THAT MAKES THE PASS SIDE HONEST. Two independent reviewers
 * landed on the same failure mode: a command that SCANS a corpus ("audit every
 * review file, fail if any violates X") exits 0 when the corpus is empty. On a
 * data-less checkout that reads as "the card's problem is fixed" when nothing
 * was examined at all. Some scripts defend themselves — BRO-2356's
 * audit-cv-flag-contradiction.js refuses with "The gate cannot pass vacuously"
 * — but that is per-script courtesy, not a property this audit can rely on.
 *
 * So a pass from an incomplete checkout is reported in its own, weaker bucket
 * rather than being laundered into a stale nomination. Wording alone would not
 * do it: the whole point is that the output looks identical either way.
 *
 * KNOWN LIMITATION, deliberately accepted (BRO-2980). A fresh checkout NEVER
 * has data/review-texts, so in practice `complete` is always false and every
 * pass lands in the unconfirmed bucket — the actionable `premise-stale-candidate`
 * bucket effectively never fires unattended. That is the safe direction (the
 * cost of a wrong "your premise is stale" is a real bug getting closed), but it
 * is real signal loss, and a second-round reviewer was right to call it out.
 *
 * The two ways to recover the signal were both rejected as unsound to ship
 * under this session's constraints, and are carded instead:
 *   - Scope the requirement per command by scanning the named script's source
 *     for corpus references. UNSOUND: a test that reaches a corpus through a
 *     transitive require would not match, and under-demoting is exactly the
 *     dangerous direction.
 *   - Link the real data/review-texts into the disposable checkout. This makes
 *     `complete` true and the bucket meaningful, but it exposes the live corpus
 *     to UNTRUSTED commands taken off cards; it would need to be opt-in and
 *     read-only, which is more surface than a fix should carry.
 */
function assessCheckoutData(wt) {
  const missing = [];
  for (const rel of REQUIRED_CORPORA) {
    const full = path.join(wt, rel);
    let ok = false;
    try {
      ok = fs.statSync(full).isDirectory() && fs.readdirSync(full).length > 0;
    } catch {
      ok = false;
    }
    if (!ok) missing.push(rel);
  }
  return { complete: missing.length === 0, missing };
}

/**
 * Turn one runVerify() result into this audit's verdict.
 *
 * Pure, and deliberately narrow: the ONLY outcome that produces a
 * premise-stale candidate is an unambiguous pass. Everything else — a
 * failure, a timeout, a missing binary, exit 3 — leaves the card alone.
 *
 * The failing bucket is `still-failing`, NOT `premise-live`: the fresh
 * checkout carries no private-repo data, so a card whose command reads
 * data/review-texts or core data fails there regardless of its premise
 * (measured on BRO-2356). Naming that verdict `premise-live` would assert
 * something this tool cannot determine.
 *
 * @param {{status:'pass'|'fail'|'unverifiable', detail:string|null}} runResult
 * @param {{dataComplete?:boolean}} [ctx] - whether the checkout carried the
 *   corpora. A pass from an incomplete checkout is NOT a stale nomination; it
 *   is `premise-stale-unconfirmed`, because a corpus scan of an empty corpus
 *   exits 0 without examining anything.
 * @returns {{verdict:'premise-stale-candidate'|'premise-stale-unconfirmed'|'still-failing'|'unverifiable', detail:string|null}}
 */
function classifyPremiseOutcome(runResult, ctx = {}) {
  const status = runResult && runResult.status;
  const detail = (runResult && runResult.detail) || null;
  if (status === 'pass') {
    if (ctx.dataComplete === false) {
      return { verdict: 'premise-stale-unconfirmed', detail };
    }
    return { verdict: 'premise-stale-candidate', detail };
  }
  if (status === 'fail') {
    return { verdict: 'still-failing', detail };
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
    } else {
      // Refuse rather than ignore. A silently-dropped `--dryrun` or `--limit 10`
      // (space instead of `=`) would run the FULL audit — every armed open card,
      // each in a subprocess — when the caller asked for a cheap preview.
      throw new Error(`unknown argument: ${arg}\n\n${USAGE}`);
    }
  }
  return opts;
}

function report(results, skipped, opts, checkout = {}) {
  if (opts.json) {
    // stdout carries the JSON document and NOTHING else — every progress line
    // above goes to stderr — so `... --json | jq` works.
    console.log(JSON.stringify({
      results,
      skippedCount: skipped.length,
      checkoutSha: checkout.sha || null,
      dataComplete: checkout.dataComplete === true,
      missingCorpora: checkout.missing || [],
    }, null, 2));
    return;
  }
  const stale = results.filter((r) => r.verdict === 'premise-stale-candidate');
  const unconfirmed = results.filter((r) => r.verdict === 'premise-stale-unconfirmed');
  const live = results.filter((r) => r.verdict === 'still-failing');
  const unver = results.filter((r) => r.verdict === 'unverifiable');

  console.log(`\nChecked ${results.length} open card(s) against origin/main ${checkout.sha || '(unknown sha)'}; skipped ${skipped.length}.\n`);

  const line = (r) => {
    console.log(`  ${r.identifier} [${r.state}] ${r.title}`);
    console.log(`      cmd: ${r.cmd}`);
    // Print detail here too. runVerify sets "passed on retry (first run flaked)"
    // on a retry-pass — the weakest evidence there is — and hiding it laundered
    // a flake into "already PASSES".
    if (r.detail) console.log(`      note: ${String(r.detail).trim().slice(0, 160)}`);
  };

  if (stale.length) {
    console.log(`PREMISE-STALE CANDIDATES (${stale.length}) — their own acceptance command already PASSES on origin/main.`);
    console.log('A pass is evidence, not proof: read the command against the title before closing anything.\n');
    for (const r of stale) line(r);
    console.log('');
  }
  if (unconfirmed.length) {
    console.log(`PASSED, BUT NOT CORROBORATED (${unconfirmed.length}) — this checkout was missing: ${(checkout.missing || []).join(', ')}.`);
    console.log('A command that SCANS one of those corpora exits 0 on an empty corpus without examining');
    console.log('anything, which is indistinguishable from a real pass. Corroborate by hand before closing.\n');
    for (const r of unconfirmed) line(r);
    console.log('');
  }
  console.log(`Still failing: ${live.length}   No verdict: ${unver.length}\n`);
  // Print the detail for BOTH non-pass buckets. A still-failing card is very
  // often failing because this checkout has no private-repo data, not because
  // its premise is live — that is only visible in the detail, so hiding it
  // (as an earlier version did) turns an environment artefact into what reads
  // like a confirmed live bug.
  for (const r of live) console.log(`  (still failing) ${r.identifier}: ${String(r.detail || 'unknown').trim().slice(0, 160)}`);
  for (const r of unver) console.log(`  (no verdict)    ${r.identifier}: ${String(r.detail || 'unknown').trim().slice(0, 160)}`);
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

  // Progress goes to stderr so `--json` leaves stdout a clean JSON document.
  const progress = (msg) => console.error(msg);
  progress(`${issues.length} open issue(s); ${selected.length} carry a runnable acceptance command and are unstarted.`);

  if (opts.dryRun) {
    // --json must still produce a JSON document on stdout here. Moving progress
    // to stderr silently turned `--dry-run --json` into an empty pipeline,
    // because every dry-run line went to stderr and this returned before
    // report() (second-round review finding).
    if (opts.json) {
      console.log(JSON.stringify({ dryRun: true, selected, skippedCount: skipped.length }, null, 2));
      return 0;
    }
    for (const c of selected) progress(`  would check ${c.identifier} [${c.state}] :: ${c.cmd}`);
    progress(`\n--dry-run: nothing was executed.`);
    return 0;
  }
  if (!selected.length) {
    progress('Nothing to check.');
    return 0;
  }

  const checkout = makeFreshCheckout();
  const data = assessCheckoutData(checkout.wt);
  if (!data.complete) {
    progress(`checkout is missing ${data.missing.join(', ')} — passes will be reported as UNCORROBORATED.`);
  }
  const results = [];
  try {
    for (const card of selected) {
      let run;
      try {
        // attempts:1 deliberately. runVerify's retry exists to stop a flake
        // manufacturing "your finished work is broken" on the Done side. Here a
        // failure is explicitly non-actionable ("leave the card alone"), so the
        // retry buys nothing and doubles the wall clock over hundreds of cards.
        run = runVerify(checkout.wt, card.cmd, {
          attempts: 1,
          timeoutMs: CHECK_TIMEOUT_MS,
          prepared: checkout.prepared,
        });
      } catch (err) {
        // runVerify can throw (safe-form revalidation, mkdtemp for the fake
        // HOME). Without this, one throw discards every result gathered so far,
        // because report() sits after the finally and is never reached.
        run = { status: 'unverifiable', detail: `runner threw: ${err && err.message ? err.message : err}` };
      }
      const { verdict, detail } = classifyPremiseOutcome(run, { dataComplete: data.complete });
      results.push({ ...card, verdict, detail });
      progress(`  ${verdict.padEnd(28)} ${card.identifier}`);
    }
  } finally {
    removeCheckout(checkout);
  }

  report(results, skipped, opts, { sha: checkout.sha, dataComplete: data.complete, missing: data.missing });
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

module.exports = { selectAuditableCards, classifyPremiseOutcome, assessCheckoutData, parseArgs, UNSTARTED_STATES, REQUIRED_CORPORA };
