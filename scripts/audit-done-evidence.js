#!/usr/bin/env node
/**
 * audit-done-evidence.js — re-prove every recently-Done / In Review /
 * In Progress card's CLAIMED evidence against a fresh origin/main, and report
 * what no longer holds (BRO-3426). SHADOW MODE: it reports, it never writes to
 * Linear.
 *
 *   node scripts/audit-done-evidence.js              # full sweep
 *   node scripts/audit-done-evidence.js --dry-run    # plan only, writes nothing
 *   node scripts/audit-done-evidence.js --limit 25   # bounded sample
 *   node scripts/audit-done-evidence.js --help
 *
 * The board's completion claims are self-certified: a session marks a card
 * Done and nothing ever re-checks it. Over 2026-09-13/15 the Linear Migration
 * owner tab closed 26+ cards BY HAND whose state was wrong. This is the daily,
 * mechanical, visible version of that hand sweep — see
 * scripts/lib/done-evidence-audit.js for the verdict semantics and the
 * measurement behind them.
 *
 * WHAT IT REUSES rather than reinvents (BRO-3426's own instruction, and
 * CLAUDE.md §15):
 *   - scripts/lib/linear-pr-evidence.js   extractPrRef      — PR-EVIDENCE lines
 *   - scripts/lib/verify-gate.js          evaluateVerifiability — the acceptance
 *       command, with BRO-2796 newest-comment-wins precedence. (NOT
 *       autonomous-verify-cmd.js's extractVerifyCmd directly: that takes an
 *       injected validator as its 2nd/3rd arguments, so a one-argument call
 *       silently yields cmd:null and the whole channel goes quietly inert.)
 *   - scripts/lib/card-premises-auditor.js classifyVacuousCheck — the BRO-3378
 *       vacuous-`test -f` detector, used UNCHANGED and refined per-card below
 *   - scripts/lib/acceptance-check-core.js makeFreshCheckout/runVerify/
 *       removeCheckout — the recheck's existing sandboxed runner: one
 *       disposable detached worktree for the whole run, untrusted commands
 *       re-validated at run time, secret-free fake-HOME env, exit-3 =
 *       "cannot verify", retry-once before believing a failure
 *   - scripts/lib/done-evidence-remote.js  — GitHub-side ancestry, because the
 *       host checkout is depth-1 and has no history to ask (see that header)
 *
 * The ONE thing it deliberately does not reuse is scripts/autonomous-
 * acceptance-recheck.js's SELECTION. That script picks ~10 cards a night by
 * RECHECK-AFTER stamp and a 24h Done window, with a starvation sort, because
 * it was sized for a world where each check was expensive. This sweep needs
 * every candidate every night, and the measurement says it can have them: 75
 * live cards re-ran in 61 seconds. Bending selectRecheckTargets to mean both
 * things would make it answer neither question clearly.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { hasHelpFlag } = require('./lib/cli-help.js');
const { extractPrRef } = require('./lib/linear-pr-evidence.js');
const { evaluateVerifiability } = require('./lib/verify-gate.js');
const {
  classifyVacuousCheck,
  pathExistsOnOriginMain,
  fetchOriginMain,
  VACUOUS_TEST_F_UNRESOLVED,
} = require('./lib/card-premises-auditor.js');
const { makeFreshCheckout, removeCheckout, runVerify } = require('./lib/acceptance-check-core.js');
const { fetchDoneEvidenceCandidates, selectCandidates, DONE_WINDOW_DAYS } = require('./lib/done-evidence-source.js');
const { resolveEvidenceUrl, parseEvidenceUrl, pathPredatesCard, pathNeverExisted } = require('./lib/done-evidence-remote.js');
const { classifyCard, summarize, doneTally, buildDigestSnapshot, isNonProbativeCommand, adjudicateMisArmed, VERDICTS } = require('./lib/done-evidence-audit.js');
// extractCheckPaths, NOT card-premises-auditor's extractCheckFilePaths. The
// latter is deliberately narrowed to the two forms BRO-3076's vacuous-check
// rule covers (`node --test`, `test -f`), so a card armed with the generic
// `node scripts/audit-<x>.js` form extracted NOTHING and could never reach the
// mis-armed branch below — which is precisely how BRO-3335 was reported FAILED
// for naming a script that has never existed (BRO-3476). extractCheckPaths is
// the same parser isSafeCheckCommand validates the shape with, so it covers
// every SAFE_CHECK_FORM that carries a pathsGroup and can never drift from the
// set of commands the enricher is allowed to write in the first place.
const { extractCheckPaths } = require('./lib/autonomous-triage-core.js');
// Reused, not rewritten: this repo already had three `git check-ignore`
// call sites and did not need a fourth (review finding).
const { isGitIgnored } = require('./lib/observable-before-absence.js');

const REPO = path.join(__dirname, '..');
const AUDIT_DIR = path.join(REPO, 'data', 'audit');
const REPORT_PATH = path.join(AUDIT_DIR, 'done-evidence-audit.json');
const SNAPSHOT_PATH = path.join(AUDIT_DIR, 'done-evidence-digest-snapshot.json');

// Per-command ceiling. The measured median is 0.3s and the slowest non-tsc
// command in a 75-card live run was under 2s, so 60s is a hang-catcher, not a
// budget. runVerify's own default (CHECK_TIMEOUT_MS, 5 min) is sized for a
// 10-card nightly run; at ~370 cards a single wedged command must not be able
// to eat the whole step.
const VERIFY_TIMEOUT_MS = 60000;
// One attempt, not runVerify's default two. The retry exists to stop a
// transient flake from manufacturing "your finished work is broken" — which
// matters when a FAILED verdict is the output. Here a failure on an OPEN card
// is discarded as uninformative anyway, so the retry would double the run
// cost to protect a verdict that is mostly thrown away. Done cards, where the
// verdict does accuse, are re-attempted explicitly below.
const VERIFY_ATTEMPTS = 1;
const DONE_VERIFY_ATTEMPTS = 2;
// Never START a check with less than this left. A command begun at the buzzer
// is SIGTERMed mid-flight and comes back 'unverifiable', which reads as a
// statement about the CARD ("no way to check this") rather than the honest
// "the sweep ran out of time". Same MIN_REMAINING_MS_TO_START shape the
// acceptance recheck and the other time-budgeted scripts here use.
const MIN_REMAINING_MS_TO_START = 60 * 1000;
// Wall-clock stop. The host job's other steps already sum close to its
// ceiling, and this step is continue-on-error: running long is worse than
// reporting a partial sweep, which is why unfinished cards are recorded as
// not-re-run rather than dropped.
const DEFAULT_TIME_BUDGET_MIN = 8;

const USAGE = `audit-done-evidence.js — re-prove every Done(${DONE_WINDOW_DAYS}d)/In Review/In Progress card's claimed evidence against fresh origin/main.

Usage:
  node scripts/audit-done-evidence.js [--limit N] [--time-budget-min ${DEFAULT_TIME_BUDGET_MIN}]
  node scripts/audit-done-evidence.js --dry-run   plan only — no checks run, nothing written
  node scripts/audit-done-evidence.js --help

Writes data/audit/done-evidence-audit.json (full report) and
data/audit/done-evidence-digest-snapshot.json (morning-digest view model).
SHADOW MODE: never writes to Linear, never changes an issue's state.

Kill switch: DONE_EVIDENCE_AUDIT_KILL_SWITCH=true skips the run entirely.`;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const k = t.slice(2);
    const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) a[k] = true;
    else { a[k] = n; i++; }
  }
  return a;
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(`${filePath}.tmp`, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(`${filePath}.tmp`, filePath);
}

/**
 * Is this card's acceptance command incapable of testing its own claim?
 *
 * Two questions, in order, and the second is what makes the first safe to ask
 * of a FINISHED card:
 *
 *  1. classifyVacuousCheck (BRO-3378, used unchanged) answers "is this a
 *     `test -f` whose path is already on origin/main". That is the right
 *     question for an OPEN card — the work is not finished, so a check that is
 *     already green cannot distinguish done from not-done.
 *  2. For a DONE card it is the wrong question on its own, because a path
 *     existing is exactly what success looks like. So a Done card's flagged
 *     path is put to pathPredatesCard: did it exist BEFORE this issue was
 *     filed? Only then is the check vacuous. This is BRO-3426's
 *     `git log --diff-filter=A` vs createdAt, asked of GitHub because a
 *     depth-1 CI checkout has no history to ask (done-evidence-remote.js).
 *
 * Fail-open at every step, matching classifyVacuousCheck's own contract: an
 * unresolved probe is never scored as vacuous, so a rate-limited or offline
 * run can never manufacture "your acceptance criteria is worthless".
 */
function refineVacuous(card, cmd, existsFn, { remoteOpts = {}, log = () => {} } = {}) {
  const verdict = classifyVacuousCheck(cmd, existsFn);
  if (!verdict) return null;
  // The oracle could not answer — the enricher's posture (defer) and the
  // auditor's posture (drop) agree that this is not a defect.
  if (verdict.kind === VACUOUS_TEST_F_UNRESOLVED) return null;
  // An arity error (`test -f a b`, exit 2) can never pass at all. It is not
  // about when the path was created, so it is reported as-is on any card.
  if (verdict.polarity === 'never-passes') return verdict;
  if (card.state !== 'Done') return verdict;

  const p = (verdict.paths || [])[0];
  const predates = pathPredatesCard(p, card.createdAt, remoteOpts);
  if (predates === null) {
    // NOT `return null`. Returning null would drop the finding, the `test -f`
    // would then be executed, it would pass (the path demonstrably exists),
    // and the card would be reported VERIFIED — so a GitHub outage would
    // silently convert the board's weakest evidence into its cleanest result.
    // Hand it back marked unresolved instead: classifyCard reports it as
    // unverifiable, which is what "we could not tell" actually means.
    log(`[done-evidence] could not date ${p} for ${card.id} — reporting its check as unverifiable, not vacuous and not verified`);
    return {
      ...verdict,
      unresolvedAge: true,
      reason: `\`${cmd}\` names ${p}, which already exists on main; whether it predates this card could not be resolved this run, so the check proves nothing either way`,
    };
  }
  if (!predates) return null; // the card's own work created it — legitimate
  return {
    ...verdict,
    reason: `\`${cmd}\` names ${p}, which was already in the repo before this card was filed — green before the work started, so it proves nothing now`,
  };
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  // Same pattern as ACCEPTANCE_RECHECK_KILL_SWITCH: `gh variable set
  // DONE_EVIDENCE_AUDIT_KILL_SWITCH --body true` stops this instantly without
  // a code change or a revert.
  if (process.env.DONE_EVIDENCE_AUDIT_KILL_SWITCH === 'true') {
    console.error('[done-evidence] DONE_EVIDENCE_AUDIT_KILL_SWITCH is set — skipping this run entirely');
    return;
  }

  const args = parseArgs(argv);
  const dryRun = !!args['dry-run'];
  const limit = Number(args.limit) > 0 ? Number(args.limit) : Infinity;
  let timeBudgetMs = DEFAULT_TIME_BUDGET_MIN * 60000;
  if (args['time-budget-min'] !== undefined) {
    const parsed = Number(args['time-budget-min']);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      // Fail loudly rather than letting NaN through: a NaN deadline makes
      // every `Date.now() > deadline` false forever, silently removing the
      // exact bound the flag exists to add (the same hole task #695's
      // ship-check found in the acceptance recheck).
      console.error(`Error: --time-budget-min must be a positive number, got ${JSON.stringify(args['time-budget-min'])}`);
      process.exit(1);
    }
    timeBudgetMs = parsed * 60000;
  }

  // The clock starts HERE, before the Linear fetch / origin fetch / checkout,
  // not after them. Those cost up to ~3.5min of network worst-case, and the
  // budget exists to keep the whole STEP inside its timeout-minutes — a budget
  // that only starts counting after setup can overrun the step, and a step
  // killed by its hard timeout writes nothing at all, losing the whole night
  // (review finding).
  const startedAt = Date.now();
  const generatedAt = new Date().toISOString();
  const fetched = await fetchDoneEvidenceCandidates(undefined, {});
  if (fetched.error) {
    console.error(`[done-evidence] Linear fetch failed: ${fetched.error}`);
    // No report is written on a hard fetch failure. The digest's own 36h
    // staleness banner (digest-snapshots.js) is what surfaces this — writing a
    // report full of zeros would look exactly like a clean board.
    if (!fetched.cards.length) {
      // Exit NON-ZERO. The step is continue-on-error, so this does not fail the
      // job — but a silent exit 0 that writes nothing is indistinguishable from
      // a clean night in the Actions UI, and the only other signal is the
      // digest's 36h staleness banner a day and a half later. A missing
      // LINEAR_API_KEY in CI hiding behind a green step is the exact shape
      // BRO-3373's ship-check caught once already (review finding).
      process.exitCode = 1;
      return;
    }
  }
  if (fetched.truncated) console.error('[done-evidence] WARN the Linear listing was truncated — coverage may be incomplete');

  // DAILY ROTATION (Codex adversarial finding). The sweep normally finishes
  // inside its budget, but when it does not, the cards that get dropped are
  // whatever sits at the end of Linear's stable creation-order listing — the
  // SAME tail every night, forever unchecked, which is the starvation
  // selectRecheckTargets' own guard exists to prevent for the nightly recheck.
  // Rotating the start offset by day-of-year costs nothing, needs no per-card
  // history, and guarantees every card reaches the front within a bounded
  // number of days. Deterministic within a day, so re-running the sweep twice
  // on the same day sweeps the same order.
  const ordered = selectCandidates(fetched.cards);
  const dayOfYear = Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 86400000);
  const offset = ordered.length ? (dayOfYear % ordered.length) : 0;
  const candidates = [...ordered.slice(offset), ...ordered.slice(0, offset)].slice(0, limit);
  console.error(`[done-evidence] ${candidates.length} candidate card(s) (Done ${DONE_WINDOW_DAYS}d + In Review + In Progress)`);

  // Evidence extraction is pure and cheap — do it for every card up front so
  // the plan is fully known before any checkout or network call.
  const planned = candidates.map((card) => {
    const prRef = extractPrRef([card.notes, ...(card.comments || [])].join('\n\n'));
    const gate = evaluateVerifiability(card.notes, card.comments);
    return { card, prRef, cmd: gate.cmd || null };
  });

  if (dryRun) {
    for (const p of planned) {
      console.log(`  ${p.card.id} [${p.card.state}] pr=${p.prRef ? (p.prRef.url || 'no-url') : 'none'} cmd=${p.cmd || 'none'}`);
    }
    console.log(`\n${planned.length} card(s) would be swept; nothing was run and nothing was written.`);
    return;
  }

  // ── vacuous-check oracle ───────────────────────────────────────────────
  // One origin/main fetch and one existence cache for the whole run, exactly
  // as findCardCheckPathDefects does — two independent sweeps could disagree
  // about a path that landed upstream between them.
  const fetchedMain = fetchOriginMain({ repo: REPO, log: (m) => console.error(m) });
  const existsCache = new Map();
  const existsFn = (p) => {
    // A failed fetch must not fall through to whatever origin/main happens to
    // be cached locally — `git cat-file` reads the local ref regardless, so a
    // file that landed upstream since the last successful fetch would read as
    // confirmed-missing. null is "unresolved", which is never a defect.
    if (!fetchedMain) return null;
    if (!existsCache.has(p)) existsCache.set(p, pathExistsOnOriginMain(p, { repo: REPO }));
    return existsCache.get(p);
  };

  const needsCheckout = planned.some((p) => p.cmd);
  let checkout = null;
  if (needsCheckout) {
    try {
      checkout = makeFreshCheckout({ repo: REPO, prefix: 'done-evidence-' });
      console.error(`[done-evidence] checkout ${checkout.sha.slice(0, 12)} prepared=${checkout.prepared}`);
    } catch (err) {
      console.error(`[done-evidence] could not build a fresh main checkout: ${String(err.message).slice(0, 200)}`);
    }
  }

  const results = [];
  const deadline = startedAt + timeBudgetMs;
  let notRun = 0;
  // Every GitHub probe that could not be answered. Surfaced in the digest
  // banner, because a rate-limited run reaches the same verdicts a clean board
  // does (UNKNOWN never accuses) and would otherwise be indistinguishable from
  // one — the exact "incomplete inventory looks complete" failure this sweep
  // is built to catch elsewhere (Codex adversarial finding).
  let unresolvedProbes = 0;
  // Per-card wall time, kept in the report. Measured live 2026-09-15: 374
  // cards in ~9min, but the distribution is extremely skewed — a `node --test`
  // is ~0.3s while a corpus-scanning `node scripts/validate-data.js` or
  // scoring-delta.js is tens of seconds, and 30 of the latter are most of the
  // run. Recording it is what lets the next person tune the budget from data
  // instead of guessing, and what will show it growing as the board grows.
  const durations = [];
  try {
    for (const { card, prRef, cmd } of planned) {
      const outOfTime = Date.now() > deadline - MIN_REMAINING_MS_TO_START;
      const cardStart = Date.now();

      // Ancestry: only for the handful of cards that carry a PR-EVIDENCE url
      // (19 board-wide, measured). Skipped past the deadline like everything
      // else — it is a network call, not a free one.
      let ancestry = null;
      if (prRef && prRef.url && !outOfTime) {
        ancestry = resolveEvidenceUrl(prRef.url);
        // Only a GIT-shaped url that failed to resolve counts as a failed
        // probe: a prod-data URL or a foreign-repo link is 'unknown' by
        // design, not by failure, and must not inflate the coverage warning.
        if (ancestry === 'unknown' && ['commit', 'pull'].includes(parseEvidenceUrl(prRef.url).kind)) unresolvedProbes++;
      }

      let vacuous = cmd && !outOfTime
        ? refineVacuous(card, cmd, existsFn, { log: (m) => console.error(m) })
        : null;
      // If origin/main could not be fetched, existsFn answers null for
      // EVERYTHING, so classifyVacuousCheck finds nothing and every `test -f`
      // would instead be EXECUTED, pass (the file is right there in the
      // checkout) and be reported VERIFIED. One fetch blip would convert ~40
      // of the board's weakest checks into its cleanest results. Mark them
      // unresolved instead (review finding).
      if (!fetchedMain && cmd && /^\s*test -f\b/.test(cmd) && !vacuous) {
        vacuous = {
          unresolvedAge: true,
          reason: `\`${cmd}\` could not be judged this run — origin/main was unreachable, so whether this check can ever fail is unknown`,
        };
      }
      if (vacuous && vacuous.unresolvedAge) unresolvedProbes++;

      // A vacuous command is not worth executing: its verdict is known to
      // carry no information, and running it would spend the budget to learn
      // nothing. classifyCard reaches VACUOUS without it.
      // A non-probative command (npx tsc / next lint) is never executed: it is
      // green on main for every card at once, so the run would cost ~15s to
      // learn nothing. classifyCard reports it as unverifiable with that
      // reason. Skipping the 16 live candidates cut ~4min off a 7m38s sweep.
      let runResult = null;
      if (cmd && !vacuous && isNonProbativeCommand(cmd)) {
        runResult = null;
      } else if (cmd && !vacuous && checkout && checkout.prepared && !outOfTime) {
        runResult = runVerify(checkout.wt, cmd, {
          attempts: card.state === 'Done' ? DONE_VERIFY_ATTEMPTS : VERIFY_ATTEMPTS,
          timeoutMs: VERIFY_TIMEOUT_MS,
        });
      } else if (cmd && !vacuous) {
        notRun++;
      }

      // Only for a Done card whose check actually FAILED: is the path it names
      // one that has never existed at all (a wrong acceptance criterion), as
      // opposed to one that existed and is now gone (a real regression)? One
      // extra call, on ~17 cards a night.
      let misArmed = null;
      if (card.state === 'Done' && runResult && runResult.status === 'fail') {
        // Resolve the facts; adjudicateMisArmed (pure, tested) applies the rule.
        // Only CONFIRMED-absent paths cost a history lookup, so this stays at
        // roughly one GitHub call per failing Done card, as before.
        const paths = extractCheckPaths(cmd);
        const facts = {};
        for (const p of paths) {
          const presentOnMain = existsFn(p);
          if (presentOnMain !== false) {
            // Present, or unresolvable. Either way the command did not fail
            // for want of the file, so arming is not in question here.
            facts[p] = { presentOnMain, everExisted: null, gitignored: false };
            continue;
          }
          // Asked against the repo root, which always exists — unlike
          // `checkout`, which is null whenever makeFreshCheckout failed
          // (review finding). .gitignore is tracked on origin/main, so in CI
          // (itself a main checkout) this is the same file the sweep's own
          // sandbox carries. A `check-ignore` that cannot answer reports false,
          // which is safe in this direction ONLY: it declines the gitignored
          // wording and falls through to the history oracle below, and can
          // never manufacture a mis-armed verdict by itself.
          const gitignored = isGitIgnored(p, { cwd: REPO });
          if (gitignored) {
            facts[p] = { presentOnMain: false, everExisted: false, gitignored: true };
            continue;
          }
          // true = zero commits ever, false = it existed and is now gone (a
          // real regression), null = the probe failed and absolves nothing.
          const never = pathNeverExisted(p);
          if (never === null) unresolvedProbes++;
          facts[p] = {
            presentOnMain: false,
            everExisted: never === null ? null : !never,
            gitignored: false,
          };
        }
        misArmed = adjudicateMisArmed(paths, facts);
      }

      const verdict = classifyCard({
        card: { id: card.id, name: card.name, url: card.url, state: card.state },
        prRef,
        ancestry,
        cmd,
        runResult,
        vacuous,
        misArmed,
      });
      const ms = Date.now() - cardStart;
      if (runResult) durations.push({ id: card.id, cmd, ms });
      results.push({ ...verdict, ms });
    }
  } finally {
    if (checkout) removeCheckout(checkout);
  }

  if (notRun) console.error(`[done-evidence] ${notRun} card(s) had a command that was not re-run (time budget or unusable checkout) — reported as unverifiable, not dropped`);
  // Slowest few, so a step that starts overrunning its budget names the
  // commands responsible instead of just reporting fewer cards.
  const slowest = durations.slice().sort((a, b) => b.ms - a.ms).slice(0, 5);
  if (slowest.length) console.error(`[done-evidence] slowest checks: ${slowest.map((d) => `${d.id} ${(d.ms / 1000).toFixed(1)}s`).join(', ')}`);

  const counts = summarize(results);
  const tally = doneTally(results);
  const report = {
    generatedAt,
    shadow: true,
    windowDays: DONE_WINDOW_DAYS,
    truncated: !!fetched.truncated,
    fetchError: fetched.error || null,
    checkoutSha: checkout ? checkout.sha : null,
    notReRun: notRun,
    unresolvedProbes,
    sweepOffset: offset,
    elapsedMs: Date.now() - startedAt,
    timeBudgetMs,
    slowestChecks: slowest,
    counts,
    doneVerified: tally.verified,
    doneTotal: tally.done,
    results,
  };
  writeJson(REPORT_PATH, report);
  writeJson(SNAPSHOT_PATH, buildDigestSnapshot(report));

  console.error(`[done-evidence] ${tally.verified}/${tally.done} Done(${DONE_WINDOW_DAYS}d) verified · ${counts.FAILED} FAILED · ${counts.VACUOUS} vacuous · ${counts.STUCK} stuck-but-done · ${counts.UNVERIFIABLE} unverifiable`);
  for (const r of results.filter((x) => x.verdict === VERDICTS.FAILED || x.verdict === VERDICTS.STUCK)) {
    console.error(`[done-evidence]   ${r.verdict} ${r.id} — ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
  }
}

if (require.main === module) main().catch((err) => { console.error(err); process.exitCode = 1; });

module.exports = { main, USAGE, parseArgs, refineVacuous, REPORT_PATH, SNAPSHOT_PATH };
