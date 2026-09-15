/**
 * done-evidence-audit.js — pure classification for the daily evidence
 * re-verification sweep (BRO-3426).
 *
 * THE PROBLEM. Every completion claim on this board is self-certified. Over
 * 2026-09-13/15 the Linear Migration owner tab closed 26+ cards BY HAND whose
 * state was wrong, in three distinct shapes:
 *   (a) work fully merged, state stuck In Progress/In Review for weeks
 *       (BRO-374, BRO-2649, BRO-2174, BRO-2095, BRO-2209, BRO-2109 …);
 *   (b) 'Done' cards whose new test file was never registered in
 *       tests/unit-test-manifest.txt, so CI never ran it (BRO-423, BRO-2446);
 *   (c) cards armed with a VACUOUS check — `test -f <path already on main>` —
 *       green before the work starts (BRO-3378 measured 31 such cards).
 * A hand sweep is heroic and unrepeatable. This module is the judgement half
 * of the mechanical version.
 *
 * SHADOW MODE, structurally. Nothing here writes anywhere: these are pure
 * functions over already-gathered facts. The runner
 * (scripts/audit-done-evidence.js) never calls a Linear mutation. A later
 * card can add auto-flip of STUCK -> Done once the report has been right for
 * a week — deliberately not this one.
 *
 * WHY A `fail` MEANS NOTHING ON AN OPEN CARD — the measurement that shaped
 * every verdict below. Hand-run of 75 live cards (25 per state) against a
 * fresh origin/main checkout, 2026-09-15:
 *
 *   Done         23 pass /  2 fail
 *   In Review    14 pass / 11 fail
 *   In Progress   8 pass / 17 fail      (75 cards, 61s wall)
 *
 * Every single one of those 28 open-card failures was "Could not find
 * <the test file this card is going to write>". That is not a defect, it is
 * what unfinished work looks like — the NEW-ARTIFACT ALLOWANCE in
 * autonomous-triage-core.js says so explicitly. So an open card's FAIL is
 * dropped as uninformative and only its PASS is reported (as STUCK). The
 * polarity inverts for a Done card, where the same failure means the work
 * never landed: both Done failures in that run were real (BRO-3237's own test
 * file is absent from origin/main; BRO-3335 names a script that does not
 * exist there).
 *
 * That measurement also killed the per-night card cap this was first planned
 * with: 75 cards in 61s means the whole ~370-card board sweeps in ~5 minutes,
 * so there is no starvation problem to solve and no starvation sort to copy
 * from selectRecheckTargets. Every candidate is judged every night.
 *
 * Pure module — no fs, no git, no network (CLAUDE.md rule 15: the test
 * require()s these functions, it does not restate them). Everything that
 * touches the world is injected as an already-resolved fact by the runner.
 */

'use strict';

// ── verdicts ────────────────────────────────────────────────────────────────
// Ordered by how much they demand of a reader: the two that accuse come
// first, then the two that merely note, then the absence of an answer.
const VERDICTS = Object.freeze({
  // Done, and its own evidence does NOT hold against fresh origin/main.
  FAILED: 'FAILED',
  // Not Done, but its own evidence DOES hold — a Done candidate nobody moved.
  STUCK: 'STUCK',
  // Armed with a check that cannot distinguish finished work from untouched
  // work, so whatever it says proves nothing either way.
  VACUOUS: 'VACUOUS',
  // Done, and its own evidence holds. The quiet, common, correct case.
  VERIFIED: 'VERIFIED',
  // No evidence to re-prove, or the probe could not resolve this run. NEVER an
  // accusation — see the fail-open contract below.
  UNVERIFIABLE: 'UNVERIFIABLE',
});

// The states a card can be in when this sweep looks at it. Kept as data rather
// than string literals sprinkled through the branches so the runner's Linear
// query and this classifier cannot drift about which bucket is which.
const DONE_STATE = 'Done';
const OPEN_STATES = Object.freeze(['In Review', 'In Progress']);

/**
 * Tri-state outcome of re-proving one piece of evidence.
 *
 * HOLDS / BROKEN / UNKNOWN, never a bare boolean — copied deliberately from
 * scripts/lib/landing-verify.js's checkLanded() contract (LANDED /
 * NOT_LANDED / UNKNOWN), which exists because a two-state answer forces a
 * failed probe to masquerade as a negative result. That exact collapse caused
 * the 2026-08-14 incident that module's header documents: a shallow checkout
 * reported genuinely-landed commits as "not landed" and nearly triggered a
 * force-push "recovery". Here the same collapse would print "your finished
 * work is broken" at a card whose evidence nobody could reach.
 */
const EVIDENCE = Object.freeze({ HOLDS: 'holds', BROKEN: 'broken', UNKNOWN: 'unknown' });

/**
 * Commands that are green on origin/main BY CONSTRUCTION and therefore say
 * nothing about any particular card.
 *
 * `npx tsc --noEmit` and `npx next lint` pass on main whenever main is
 * healthy, for every card simultaneously — so a card armed with one cannot be
 * distinguished from a card whose work was never done. That is the same
 * "vacuous in spirit" property card-premises-auditor.js's header names for
 * these two commands, and the same reason it declines to treat them as proof.
 *
 * Measured on the first live sweep (2026-09-15, 371 cards): 16 candidates are
 * armed this way, and running them produced 6 VERIFIED and 10 STUCK verdicts —
 * every one of them false confidence, since main being type-clean says nothing
 * about the 16 unrelated claims attached to it. They are now reported as
 * unverifiable instead, which is the honest answer, and not executed at all,
 * which also removed ~4 minutes from a 7m38s run (`npx tsc --noEmit` alone
 * costs ~15s a time).
 *
 * Deliberately NOT rejected as vacuous: the enricher's own prompt names tsc as
 * the honest "cannot infer a better command" fallback, so a card armed this
 * way is under-specified, not defective — a distinction audit-card-
 * verifiability.js already owns and this sweep should not re-litigate.
 */
const NON_PROBATIVE_RE = /^\s*npx\s+(tsc|next\s+lint)\b/;

function isNonProbativeCommand(cmd) {
  return NON_PROBATIVE_RE.test(String(cmd || ''));
}

/**
 * Did this check fail because the SANDBOX lacks something, rather than because
 * the card's work is broken?
 *
 * acceptance-check-core.js already folds the three environment failures it can
 * see into 'unverifiable' — no node_modules (prepared:false), the repo's
 * exit-3 convention, and spawn/timeout errors — and its own comment states the
 * residual it cannot: "a checkout can be prepared:true and still be missing a
 * data file a command needs — that residual case still reads as FAIL".
 *
 * That residual is not hypothetical here. The fresh checkout has no
 * data/review-texts (a separate PRIVATE repo, CLAUDE.md §11, cloned by a
 * dedicated CI step and never by `git worktree add`), and on the first live
 * sweep three Done cards — BRO-2200, BRO-2050, BRO-2044 — were reported FAILED
 * purely because of it. All three are gates that scan the review corpus and
 * say so in plain words before exiting 1.
 *
 * Accusing three finished P0 fixes of being broken is the single worst output
 * this sweep could produce: it is precisely the kind of false alarm that
 * teaches the owner to stop reading the block, which costs more than the stale
 * Done ever did. So a failure whose own message names a missing data
 * dependency is downgraded to "cannot verify" — the same fail-open direction
 * every other uncertainty in this module takes.
 *
 * Matched on the checks' OWN wording rather than on a path prefix in the
 * command: these gates are invoked as ordinary `node scripts/audit-*.js`
 * commands that name no data path at all, so there is nothing in the command
 * string to match. The patterns are anchored on the explicit "I could not
 * read the corpus" sentences these scripts print, not on a bare keyword, so an
 * ordinary assertion failure that merely mentions a filename cannot trip them.
 */
const ENVIRONMENT_FAILURE_PATTERNS = Object.freeze([
  // scripts/lib/review-corpus gates: "FAIL: scanned 0 review files —
  // data/review-texts is missing or empty. The gate cannot pass vacuously."
  /scanned 0 review files/i,
  /data\/review-texts is missing or empty/i,
  /review-texts.{0,40}(not checked out|missing|unavailable)/i,
  // A check killed by this sweep's own per-command cap. acceptance-check-core.js
  // already maps a timeout to 'unverifiable' via two guards (`err.signal &&
  // err.status == null`, and the spawn-error branch), but a `spawnSync <bin>
  // ETIMEDOUT` reaches neither and lands in the generic `fail` tail — observed
  // live on BRO-258, which was reported FAILED purely for exceeding the 60s
  // ceiling this sweep imposes (runVerify's own default is 5 minutes). A
  // command the sweep cut short produced no verdict, and "no verdict" must
  // never render as "your finished work is broken".
  /\bETIMEDOUT\b/,
  /killed by SIG[A-Z]+ after \d+ms/i,
]);

function isEnvironmentFailure(detail) {
  const s = String(detail || '');
  if (!s) return false;
  return ENVIRONMENT_FAILURE_PATTERNS.some((re) => re.test(s));
}

/**
 * Replace the disposable checkout's path with a stable placeholder.
 *
 * makeFreshCheckout builds its worktree under an mkdtemp directory, so every
 * absolute path in a failure message contains a random component that differs
 * on every single run (`…/T/done-evidence-9HYDGn/main/…`). Two reasons that
 * matters, and the second is the load-bearing one:
 *
 *   1. It is noise in the owner's email — the reader needs the repo-relative
 *      path, never the sandbox it happened to be checked out into.
 *   2. data/audit/done-evidence-audit.json is COMMITTED by CI every night. A
 *      path that changes each run makes the file diff every night even when
 *      every verdict is identical, which turns a genuinely-changed report into
 *      something nobody can spot in a diff — and quietly adds a commit a day
 *      to the data/audit push contention this job already documents at length.
 */
// The intervening directories are OPTIONAL, which is the whole point: macOS
// mkdtemp yields /private/var/folders/__/<hash>/T/<prefix>-XXXX/main/, while a
// Linux CI runner — the host this actually ships to — yields the flat
// /tmp/<prefix>-XXXX/main/. An earlier version required at least one
// intermediate segment and so scrubbed only the developer's laptop output,
// leaving the committed CI report churning nightly (caught by this module's
// own test, not in review).
const SANDBOX_PATH_RE = /(?:\/private)?\/(?:var|tmp)(?:\/[^\s'"]*?)?\/(?:done-evidence|acceptance-check|auto-recheck)-[A-Za-z0-9]+\/main\//g;

function scrubSandboxPaths(text) {
  return String(text == null ? '' : text).replace(SANDBOX_PATH_RE, '<checkout>/');
}

// Command output goes into an HTML email. A `node --test` failure is a
// multi-line stack trace carrying an absolute /private/var/folders/... temp
// path, and the first live sweep put exactly that into the digest (BRO-3335's
// row). Collapse to one line and clip: the full text stays in the JSON report,
// which is where someone debugging should be looking anyway.
const DIGEST_DETAIL_CHARS = 180;

function tidyDetail(detail, { maxChars = DIGEST_DETAIL_CHARS } = {}) {
  if (!detail) return null;
  const one = String(detail).replace(/\s+/g, ' ').trim();
  if (!one) return null;
  return one.length > maxChars ? `${one.slice(0, maxChars - 1)}…` : one;
}

/**
 * Why a card's acceptance command can never have judged its own work.
 *
 * Both kinds mean the same thing operationally — the command was wrong the day
 * it was written and would have failed identically before, during and after
 * the work — but they need DIFFERENT words, because saying the wrong one is
 * itself a false statement to the reader. BRO-10 is armed
 * `test -f memory/cyrus-decision.txt`; that file is 1.5KB on the owner's disk
 * right now. Telling them it "has never existed in this repo" is not a
 * harmless imprecision, it is the sweep being confidently wrong in exactly the
 * way it exists to catch — memory/ is gitignored (.gitignore `/memory/`), so
 * it is invisible to the origin/main checkout and to nothing else.
 */
const MIS_ARMED = Object.freeze({
  // Zero commits ever touched this path, anywhere in history.
  NEVER_EXISTED: 'never-existed',
  // The path is gitignored, so no checkout built from origin/main can see it,
  // whether or not it exists on the machine that wrote the card.
  GITIGNORED: 'gitignored',
});

/**
 * Given the already-resolved facts about every path a failing command names,
 * is the CARD mis-armed rather than the WORK broken?
 *
 * Pure by construction: the runner does the git/GitHub I/O and hands the
 * answers in, exactly as with `ancestry` and `runResult`. Keeping the
 * adjudication here rather than inline in the runner is what makes it
 * testable at all (CLAUDE.md rule 15) — the rule below is the whole safety
 * argument of this change and must not live somewhere no test can reach it.
 *
 * THE RULE, and why each clause is load-bearing:
 *
 *   - Only CONFIRMED-ABSENT paths are adjudicated. A path that is present on
 *     main, or whose presence could not be resolved, says nothing about
 *     arming: the command failed on its CONTENTS, which is a real regression.
 *   - If nothing is confirmed absent, never mis-armed. This is what keeps
 *     BRO-472 (`node scripts/check-health-row-absent.js …`, a script that is
 *     right there on main and genuinely reports a still-present health row)
 *     reported as FAILED, where it belongs.
 *   - EVERY confirmed-absent path must be mis-armed, not merely one. A
 *     command naming four test files, one a typo and one genuinely DELETED,
 *     is a real regression wearing a typo as camouflage; requiring unanimity
 *     is what stops this branch from laundering it. Fail-closed on purpose:
 *     when in doubt the card stays accused, because the cost of a missed
 *     regression is bounded and the cost of a false accusation is the reader
 *     learning to ignore the whole block.
 *   - An UNRESOLVED history answer (null — the GitHub probe failed) is not
 *     mis-armed. It is not evidence of anything, and treating "we could not
 *     ask" as "the card is fine" would let one rate-limited night quietly
 *     absolve every genuinely broken card on the board.
 *
 * @param {string[]} paths every path the failing command names
 * @param {Object<string,{presentOnMain:boolean|null, everExisted:boolean|null,
 *   gitignored:boolean}>} facts resolved per path by the runner
 * @returns {{path:string, kind:string, paths:string[]}|null}
 */
function adjudicateMisArmed(paths, facts) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (!list.length) return null;
  const f = facts || {};
  const absent = list.filter((p) => f[p] && f[p].presentOnMain === false);
  if (!absent.length) return null;

  const kinds = absent.map((p) => {
    // Gitignored is checked FIRST and wins. A gitignored path also has zero
    // commits, so the history oracle would answer `never existed` for it and
    // print the one sentence that is demonstrably false about the file the
    // owner can see on disk. Ordering these the other way round is the bug.
    if (f[p].gitignored === true) return MIS_ARMED.GITIGNORED;
    if (f[p].everExisted === false) return MIS_ARMED.NEVER_EXISTED;
    return null;
  });
  if (kinds.some((k) => k === null)) return null;

  return { path: absent[0], kind: kinds[0], paths: absent };
}

/**
 * Re-prove a PR-EVIDENCE line's commit/PR reference.
 *
 * Takes the ALREADY-RESOLVED ancestry answer (the runner asks GitHub; see
 * scripts/audit-done-evidence.js for why the check must be remote-side rather
 * than `git merge-base --is-ancestor`), so this stays pure and testable.
 *
 * @param {{merged:boolean,deployed:boolean,checked:boolean,url:string|null}|null} prRef
 *   linear-pr-evidence.js's extractPrRef() output — null when the card has no
 *   PR-EVIDENCE line at all.
 * @param {'holds'|'broken'|'unknown'|null} ancestry - did the referenced
 *   commit/PR actually land on main? null when there was nothing to resolve.
 * @returns {{state:string, detail:string|null}}
 */
function evaluatePrEvidence(prRef, ancestry) {
  if (!prRef) return { state: EVIDENCE.UNKNOWN, detail: null };
  // A PR-EVIDENCE line with no URL is a bare claim ("PR-EVIDENCE: merged
  // deployed checked") with nothing to re-prove. It is not evidence that
  // BROKE — there was never anything there to check — so it must not
  // manufacture a FAILED. Measured live: 3 of the 19 PR-EVIDENCE lines on the
  // board carry no URL, and one (BRO-3247) points at a production data JSON
  // rather than a commit, which is a legitimate deploy proof this sweep
  // simply has no way to re-run.
  if (!prRef.url) return { state: EVIDENCE.UNKNOWN, detail: 'PR-EVIDENCE line names no commit or PR to re-check' };
  if (ancestry === EVIDENCE.HOLDS) return { state: EVIDENCE.HOLDS, detail: null };
  if (ancestry === EVIDENCE.BROKEN) {
    return { state: EVIDENCE.BROKEN, detail: `PR-EVIDENCE names ${prRef.url}, which is not on main` };
  }
  return { state: EVIDENCE.UNKNOWN, detail: `could not resolve ${prRef.url} against main this run` };
}

/**
 * Re-prove the card's own acceptance command.
 *
 * @param {{status:'pass'|'fail'|'unverifiable', detail:string|null}|null} runResult
 *   acceptance-check-core.js's runVerify() output, or null when the command
 *   was not re-run this sweep.
 * @param {string|null} cmd
 * @returns {{state:string, detail:string|null}}
 */
function evaluateVerifyRun(runResult, cmd) {
  if (!cmd) return { state: EVIDENCE.UNKNOWN, detail: null };
  // Checked BEFORE the missing-result branch: a non-probative command is
  // deliberately never executed, so it always arrives here with runResult
  // null, and it must report WHY it proves nothing rather than the generic
  // "was not re-run this sweep".
  if (isNonProbativeCommand(cmd)) {
    return { state: EVIDENCE.UNKNOWN, detail: `\`${String(cmd).trim()}\` is green on main for every card at once — it cannot show whether THIS work was done` };
  }
  if (!runResult) return { state: EVIDENCE.UNKNOWN, detail: 'its check was not re-run this sweep' };
  // runVerify already folds every "the environment, not the card, is wrong"
  // case into 'unverifiable' for us: a checkout with no node_modules
  // (prepared:false), the repo's exit-3 "cannot verify" convention, and
  // spawn/timeout errors. Honouring that verbatim is what keeps a missing
  // private-repo dependency or a cold checkout from being reported as broken
  // work.
  if (runResult.status === 'unverifiable') return { state: EVIDENCE.UNKNOWN, detail: runResult.detail || null };
  if (runResult.status === 'pass') return { state: EVIDENCE.HOLDS, detail: null };
  // The residual environment failure acceptance-check-core.js cannot classify
  // for itself — a prepared checkout still missing the private review corpus.
  if (isEnvironmentFailure(runResult.detail)) {
    const timedOut = /\bETIMEDOUT\b|killed by SIG/i.test(String(runResult.detail || ''));
    return {
      state: EVIDENCE.UNKNOWN,
      detail: timedOut
        ? 'its check ran past this sweep\'s time limit and was cut short — no verdict either way'
        : 'its check needs the private review-texts corpus, which this sandbox does not have — cannot verify either way',
    };
  }
  return { state: EVIDENCE.BROKEN, detail: scrubSandboxPaths(runResult.detail) || `\`${cmd}\` does not pass on main` };
}

/**
 * Combine the two evidence channels into one verdict for one card.
 *
 * A card can carry a PR-EVIDENCE line, an acceptance command, both, or
 * neither. HOLDS from EITHER channel is enough to say the evidence holds —
 * they are independent proofs of the same claim, not two halves of one. But
 * BROKEN from either is NOT symmetric: it only counts when nothing else
 * holds, so a card whose test passes on main is never accused because a
 * hand-typed commit URL in its PR-EVIDENCE line has a typo in it.
 *
 * @param {{state:string,detail:string|null}} pr
 * @param {{state:string,detail:string|null}} verify
 * @returns {{state:string, detail:string|null, channels:string[]}}
 */
function combineEvidence(pr, verify) {
  // A BROKEN acceptance command is never overridden by a holding PR-EVIDENCE
  // line, and this precedence is the difference between catching a regression
  // and laundering it (Codex adversarial finding, pre-ship).
  //
  // The two channels do not prove the same thing over time. Ancestry is a
  // HISTORICAL fact — "this commit is reachable from main" — and an ordinary
  // `git revert` PRESERVES it: the original commit stays in history forever, so
  // done-evidence-remote.js's compare call keeps answering `behind` long after
  // the change itself was undone. The acceptance command, by contrast, is a
  // statement about main RIGHT NOW. So when they disagree in this direction,
  // the command is the one telling the truth, and an earlier version of this
  // function returned VERIFIED for exactly the case this sweep exists to
  // catch: work that landed, got reverted, and still reads as finished.
  //
  // The asymmetry is deliberate and does not invert: a BROKEN ancestry result
  // still loses to a passing command (below), because a hand-typed commit URL
  // with a typo in it must never accuse code that demonstrably works.
  if (verify.state === EVIDENCE.BROKEN) {
    return { state: EVIDENCE.BROKEN, detail: verify.detail, channels: ['verify-command'] };
  }
  const holds = [pr, verify].filter((e) => e.state === EVIDENCE.HOLDS);
  if (holds.length) {
    return {
      state: EVIDENCE.HOLDS,
      detail: null,
      channels: [pr.state === EVIDENCE.HOLDS ? 'pr-evidence' : null, verify.state === EVIDENCE.HOLDS ? 'verify-command' : null].filter(Boolean),
    };
  }
  const broken = [pr, verify].filter((e) => e.state === EVIDENCE.BROKEN);
  if (broken.length) {
    return {
      state: EVIDENCE.BROKEN,
      detail: broken.map((e) => e.detail).filter(Boolean).join('; ') || null,
      channels: [pr.state === EVIDENCE.BROKEN ? 'pr-evidence' : null, verify.state === EVIDENCE.BROKEN ? 'verify-command' : null].filter(Boolean),
    };
  }
  return {
    state: EVIDENCE.UNKNOWN,
    detail: [pr.detail, verify.detail].filter(Boolean).join('; ') || null,
    channels: [],
  };
}

/**
 * The verdict for one card.
 *
 * @param {object} o
 * @param {{id:string,name:string,url?:string,state:string}} o.card
 * @param {{merged,deployed,checked,url}|null} [o.prRef] extractPrRef() output
 * @param {'holds'|'broken'|'unknown'|null} [o.ancestry] resolved by the runner
 * @param {string|null} [o.cmd] the card's own acceptance command
 * @param {{status,detail}|null} [o.runResult] runVerify() output, or null
 * @param {{path:string}|null} [o.misArmed] set when the command names a path that
 *   has NEVER existed in the repo — see the mis-armed branch below.
 * @param {{kind:string,reason:string,paths:string[]}|null} [o.vacuous]
 *   card-premises-auditor.js's classifyVacuousCheck() output, REFINED by the
 *   runner against the card's createdAt — see classifyCard's VACUOUS branch.
 * @returns {{id,name,url,state,verdict,evidence,detail,cmd,channels}}
 */
function classifyCard({ card, prRef = null, ancestry = null, cmd = null, runResult = null, vacuous = null, misArmed = null } = {}) {
  const id = (card && card.id) || null;
  const base = {
    id,
    name: (card && card.name) || '(untitled)',
    url: (card && card.url) || null,
    state: (card && card.state) || null,
    cmd: cmd || null,
  };

  const pr = evaluatePrEvidence(prRef, ancestry);
  const verify = evaluateVerifyRun(runResult, cmd);
  const evidence = combineEvidence(pr, verify);

  // VACUOUS FIRST, and it outranks a passing check on purpose. The whole
  // point of the class is that the check's verdict carries no information: a
  // `test -f` on a path that predates the card is green whether or not anyone
  // did the work, so counting its pass as VERIFIED (or, on an open card, as
  // STUCK) would launder exactly the false confidence BRO-423 shipped with.
  // It does NOT outrank an independent PR-EVIDENCE proof — that channel is
  // untainted by the weak command, so a card with both is judged on the half
  // that actually proves something.
  if (vacuous && pr.state !== EVIDENCE.HOLDS) {
    return {
      ...base,
      // `unresolvedAge` means the oracle could not date the path, so we cannot
      // tell a vacuous check from an honest one. Reporting VACUOUS there would
      // accuse on an outage; reporting nothing would be worse — the command
      // would then be RUN, pass (it is a `test -f` on a file that exists), and
      // the card would come out VERIFIED. A GitHub blip must not be able to
      // upgrade the weakest evidence on the board into a clean bill of health
      // (Codex adversarial finding, pre-ship). Both branches agree the command
      // proves nothing; only the label differs.
      verdict: vacuous.unresolvedAge ? VERDICTS.UNVERIFIABLE : VERDICTS.VACUOUS,
      evidence: EVIDENCE.UNKNOWN,
      detail: vacuous.reason,
      channels: [],
    };
  }

  const isDone = base.state === DONE_STATE;

  if (evidence.state === EVIDENCE.HOLDS) {
    return {
      ...base,
      // A Done card whose evidence holds is the system working. An OPEN card
      // whose evidence holds is the (a) class this sweep was filed for: the
      // work is provably on main and nobody moved the card. Reported as a
      // candidate, never flipped — shadow mode.
      verdict: isDone ? VERDICTS.VERIFIED : VERDICTS.STUCK,
      evidence: evidence.state,
      detail: isDone ? null : 'its own evidence holds on main — looks finished',
      channels: evidence.channels,
    };
  }

  // MIS-ARMED beats FAILED. A card whose acceptance command names a path that
  // has never existed in this repo cannot have its work judged by that
  // command — the command was wrong the day it was written and would have
  // failed identically before, during and after the work. Reporting it as
  // FAILED accuses finished work of being broken, which is the worst output
  // this sweep can produce. Two of the 17 FAILED rows in the first live run
  // were exactly this (BRO-2304, BRO-2421: both name scripts/<x> where the
  // real file is scripts/lib/<x>), found by an adversarial review of the
  // report itself. The card still deserves a fix — a wrong acceptance
  // criterion means nothing can ever verify it — so it is reported, just as
  // the honest thing rather than as a false alarm.
  if (misArmed && evidence.state === EVIDENCE.BROKEN) {
    const why = misArmed.kind === MIS_ARMED.GITIGNORED
      ? 'which is gitignored, so the fresh origin/main checkout this sweep builds can never see it — the file may well exist on the machine that wrote the card'
      : 'which has never existed in this repo';
    const alsoNames = misArmed.paths && misArmed.paths.length > 1
      ? ` (and ${misArmed.paths.length - 1} more path${misArmed.paths.length === 2 ? '' : 's'} in the same command)`
      : '';
    return {
      ...base,
      verdict: VERDICTS.UNVERIFIABLE,
      evidence: EVIDENCE.UNKNOWN,
      // Stamped HERE and nowhere else. Spreading it into `base` would mark
      // every card in the report mis-armed (review finding); this flag is the
      // one thing that tells the owner WHICH cards need re-arming, so a
      // blanket true would be worse than not having it.
      misArmed: true,
      detail: `its own check names ${misArmed.path}, ${why}${alsoNames} — the acceptance criterion is wrong, so nothing can verify this card either way`,
      channels: [],
    };
  }

  if (evidence.state === EVIDENCE.BROKEN) {
    // THE ASYMMETRY, and the single most important line in this file. On an
    // open card a broken check is overwhelmingly "the test file this card is
    // going to write does not exist yet" — 28 of 28 such failures in the
    // 2026-09-15 hand run. Reporting those would bury the two real Done
    // failures under 28 rows of ordinary unfinished work and teach the reader
    // to skip the block, which is the same failure as having no block at all
    // (in-review-backlog.js's header makes the identical argument about a
    // 120-row digest section).
    if (!isDone) {
      return {
        ...base,
        verdict: VERDICTS.UNVERIFIABLE,
        evidence: EVIDENCE.UNKNOWN,
        detail: 'still open and its check does not pass yet — expected for unfinished work, not a defect',
        channels: [],
      };
    }
    return {
      ...base,
      verdict: VERDICTS.FAILED,
      evidence: evidence.state,
      detail: evidence.detail,
      channels: evidence.channels,
    };
  }

  return {
    ...base,
    verdict: VERDICTS.UNVERIFIABLE,
    evidence: EVIDENCE.UNKNOWN,
    detail: evidence.detail || 'no PR-EVIDENCE line and no runnable acceptance command',
    channels: [],
  };
}

/** Tally by verdict. Every key is always present, so a quiet night reports
 *  zeros rather than a missing field the digest would render as "undefined". */
function summarize(results) {
  const counts = { VERIFIED: 0, FAILED: 0, STUCK: 0, VACUOUS: 0, UNVERIFIABLE: 0, total: 0 };
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || !r.verdict) continue;
    counts.total++;
    if (counts[r.verdict] !== undefined) counts[r.verdict]++;
  }
  return counts;
}

/** Done-only denominator for the headline ("41/47 Done(14d) verified"). */
function doneTally(results) {
  let done = 0;
  let verified = 0;
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || r.state !== DONE_STATE) continue;
    done++;
    if (r.verdict === VERDICTS.VERIFIED) verified++;
  }
  return { done, verified };
}

// How many rows the digest block may print. The board runs ~370 candidates and
// a block the eye learns to skip is the same failure as no block — same cap
// and same reasoning as in-review-backlog.js. Everything past this rolls into
// moreCount and lives in the JSON report.
const MAX_DIGEST_ITEMS = 8;

// Only the verdicts that ask the reader to DO something get a row. VERIFIED is
// the quiet majority and belongs in the headline count, not in eight lines of
// "still fine". UNVERIFIABLE is counted but never listed: it is the absence of
// evidence, which is a backlog-quality problem audit-card-verifiability.js
// already owns, not a claim that went bad overnight.
const REPORTABLE = Object.freeze([VERDICTS.FAILED, VERDICTS.STUCK, VERDICTS.VACUOUS]);

/**
 * Flatten a report into the {generatedAt, bannerText, items, moreCount} shape
 * renderNamedDigestBlock (scripts/lib/autonomous-email-render.js:496) already
 * knows how to render — so wiring this into the morning digest needs a
 * registry row and one render line, and no new render code at all.
 *
 * Returns null on a genuinely quiet night (nothing to act on), which
 * send-morning-digest.js reads as "print no block".
 *
 * @param {{generatedAt:string, results:Array}} report
 */
function buildDigestSnapshot(report, { maxItems = MAX_DIGEST_ITEMS } = {}) {
  const results = (report && Array.isArray(report.results)) ? report.results : [];
  const counts = summarize(results);
  const { done, verified } = doneTally(results);

  const rows = results.filter((r) => r && REPORTABLE.includes(r.verdict));
  // FAILED first — a Done card whose evidence no longer holds is the only
  // verdict here that says something the board currently claims is TRUE is
  // false. STUCK next (work sitting finished), VACUOUS last (a check to
  // strengthen, no claim in dispute).
  const rank = (r) => REPORTABLE.indexOf(r.verdict);
  rows.sort((a, b) => rank(a) - rank(b));

  // COVERAGE HONESTY (Codex adversarial finding, pre-ship). Without this, a run
  // that fetched two of five Linear pages, or ran out of budget with 200 cards
  // unchecked, prints the same confident "119/161 verified · 0 FAILED" as a
  // complete one — an incomplete inventory reading as a clean board is the
  // precise failure this whole sweep was built to detect in other people's
  // work, and it would be embarrassing to ship it here. Anything that shrank
  // coverage is named in the banner itself, not buried in the JSON.
  const gaps = [];
  if (report && report.truncated) gaps.push('the card listing was cut short');
  if (report && report.fetchError) gaps.push('the board fetch failed partway');
  const notReRun = Number(report && report.notReRun) || 0;
  if (notReRun > 0) gaps.push(`${notReRun} check${notReRun === 1 ? '' : 's'} not re-run (ran out of time)`);
  const unresolved = Number(report && report.unresolvedProbes) || 0;
  if (unresolved > 0) gaps.push(`${unresolved} GitHub lookup${unresolved === 1 ? '' : 's'} failed`);

  // Mis-armed cards are UNVERIFIABLE, and UNVERIFIABLE is deliberately not in
  // REPORTABLE — so without this count they are fixed silently, i.e. not at
  // all. They are the one flavour of unverifiable that names a SPECIFIC,
  // cheap, one-line repair (correct the card's acceptance command), as
  // opposed to the general backlog-quality problem audit-card-verifiability.js
  // owns. Counted in the banner rather than given rows, because the action is
  // "go re-arm these" and not "read eight of them over breakfast".
  const misArmedCount = results.filter((r) => r && r.misArmed === true).length;

  const bannerText =
    `${verified}/${done} Done(14d) verified on main · ` +
    `${counts.FAILED} FAILED · ${counts.VACUOUS} vacuous · ${counts.STUCK} stuck-but-done` +
    (misArmedCount ? ` · ${misArmedCount} mis-armed (wrong acceptance command, needs re-arming)` : '') +
    (gaps.length ? ` — PARTIAL RUN: ${gaps.join(', ')}, so these numbers understate the board` : '');

  if (!rows.length) {
    // Still emit a snapshot rather than null: this is a STANDING line, for the
    // same reason trunk status and backlog inflow are (send-morning-digest.js
    // renders both green when healthy). A block that only appears when it is
    // angry teaches the reader that silence means "fine", which is
    // indistinguishable from a dead producer — and a dead producer is the
    // exact failure mode this sweep exists to catch in other people's work.
    return { generatedAt: report && report.generatedAt, bannerText, items: [], moreCount: 0 };
  }

  return {
    generatedAt: report && report.generatedAt,
    bannerText,
    items: rows.slice(0, maxItems).map((r) => ({
      title: `${r.verdict} ${r.id} — ${r.name}`,
      detail: tidyDetail(r.detail),
      url: r.url || null,
    })),
    moreCount: Math.max(0, rows.length - maxItems),
  };
}

module.exports = {
  VERDICTS,
  EVIDENCE,
  DONE_STATE,
  OPEN_STATES,
  MAX_DIGEST_ITEMS,
  REPORTABLE,
  NON_PROBATIVE_RE,
  scrubSandboxPaths,
  ENVIRONMENT_FAILURE_PATTERNS,
  DIGEST_DETAIL_CHARS,
  isNonProbativeCommand,
  isEnvironmentFailure,
  tidyDetail,
  MIS_ARMED,
  adjudicateMisArmed,
  evaluatePrEvidence,
  evaluateVerifyRun,
  combineEvidence,
  classifyCard,
  summarize,
  doneTally,
  buildDigestSnapshot,
};
