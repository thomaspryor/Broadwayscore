/**
 * card-premises-auditor.js — does an armed card's file-naming acceptance
 * command (`node --test`/`npx tsx --test`/`test -f`) name a file that
 * actually exists?
 *
 * BRO-2977: isSafeCheckCommand (autonomous-triage-core.js) only validates the
 * SHAPE of a command — never that the file it names is real — so a card
 * whose acceptance criteria hallucinated or mistyped a test path is "armed"
 * and dispatchable, and only fails at RUN time, which nothing does for a
 * still-open card. Four such cards were found by hand in one bounded run of
 * audit-stale-open-premises.js (BRO-2968): their own command can never pass,
 * so they can never reach linear-brain.js's Done gate. This module turns
 * that silent starvation into a listed defect, wired into
 * audit-card-verifiability.js's existing sweep.
 *
 * BRO-3076: the exact same starvation is possible for `test -f <path>` —
 * SAFE_CHECK_FORMS' other file-naming safe form (autonomous-triage-core.js's
 * extractCheckPaths already extracts its path group; BRO-2977 just never
 * looked at it, deliberately scoping isNodeTestCommand to the two `--test`
 * forms only). A card whose acceptance is `test -f docs/hallucinated.md` is
 * just as armed and just as unpassable, so it gets the same treatment here.
 *
 * BRO-3378: the same module now also answers the OPPOSITE-polarity question —
 * "can this command ever FAIL?" — because a check that is already green before
 * the work starts proves nothing when it is re-run afterwards. See the
 * vacuous-check section below. It lives here rather than in a new module
 * because it is answered from the identical existence facts, through the
 * identical injected existsFn, against the identical origin/main oracle.
 *
 * MUST resolve against origin/main, not the caller's local checkout: a
 * worktree legitimately lacks gitignored paths, and a naive fs.existsSync
 * would report those as "missing" — the same class of mistake an earlier
 * version of BRO-2968's audit made (reporting an environment artefact as a
 * live bug). `git cat-file -e origin/main:<path>` and its null-on-transient-
 * failure convention are copied from autofix-canary.js's
 * markerExistsOnOriginMain, which already solved this exact problem for a
 * different marker path (CLAUDE.md §15 — one implementation would be nicer,
 * but that function is git-fetch-coupled to a single caller's marker path
 * story; isPathAbsentFromTreeError, the actually-shared piece, IS reused
 * as-is below).
 */
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const { extractCheckPaths } = require('./autonomous-triage-core.js');
const { repoDepthArgs } = require('./shallow-fetch-args.js');
const { isPathAbsentFromTreeError } = require('./autofix-canary.js');

const REPO = path.join(__dirname, '..', '..');

// Narrows extractCheckPaths down to the two forms whose path group names
// actual runnable *.test.mjs/*.test.js/*.test.ts files.
function isNodeTestCommand(cmd) {
  return /^(node --test|npx tsx --test)\b/.test(String(cmd || '').trim());
}

// The `test -f <docs|memory|tests|src|scripts path>` safe form (BRO-3076) —
// same starvation risk, different file, so it gets the same existence check.
function isTestFCommand(cmd) {
  return /^test -f\b/.test(String(cmd || '').trim());
}

// Scoped to the two forms BRO-2977/BRO-3076 actually cover — NOT a claim that
// every other SAFE_CHECK_FORMS shape with a pathsGroup is immune to this bug.
// The bash *.test.sh form IS immune (its regex hardcodes the one existing
// path, autonomous-triage-core.js:284 — no card-authored value to hallucinate).
// The generic audit-/lint- form is NOT immune despite checking its basename
// against AUDIT_LINT_GENERIC_FORM_ALLOWED: that allowlist deliberately admits
// basenames "shape-only," before the file exists on disk (see
// autonomous-triage-core.js's audit-worktree-unpushed.js entry and comment —
// confirmed still absent from origin/main as of this writing), so a card
// naming `node scripts/audit-worktree-unpushed.js` is exactly as armed and
// exactly as starvable as a phantom `node --test` path. Left out of scope
// here deliberately (BRO-3076 is `test -f` only) — tracked as a follow-up,
// not silently declared safe.
function isCheckPathCommand(cmd) {
  return isNodeTestCommand(cmd) || isTestFCommand(cmd);
}

// Pure: reuses the SAME regex/path-group extraction isSafeCheckCommand
// already validated the shape of, so there is no second parser to drift.
function extractCheckFilePaths(cmd) {
  if (!isCheckPathCommand(cmd)) return [];
  return extractCheckPaths(cmd);
}

/**
 * Does `relPath` exist in origin/main's tree right now?
 * @returns {boolean|null} true=present, false=CONFIRMED absent, null=could
 *   not resolve this run (fetch/git failure) — never scored as "missing".
 */
function pathExistsOnOriginMain(relPath, { repo = REPO, ref = 'origin/main', log = () => {} } = {}) {
  try {
    // `cat-file -t`, not `-e`: -e answers "is there an object here", which is
    // TRUE for a directory (a tree) as well as a file (a blob). Both commands
    // this module judges are file assertions — `test -f <dir>` always exits 1,
    // and `node --test <dir>` does not run a dir as a test file — so counting a
    // tree as "present" would report an unpassable check as satisfied and, for
    // the vacuous bucket, call a check that can only ever FAIL one that can
    // never fail (ship-check finding). resolveCheckPaths already makes exactly
    // this distinction with statSync().isFile() — autonomous-triage-core.js:469.
    const type = execFileSync('git', ['cat-file', '-t', `${ref}:${relPath}`], {
      cwd: repo, timeout: 10000, stdio: 'pipe', encoding: 'utf8',
    }).trim();
    return type === 'blob';
  } catch (err) {
    if (isPathAbsentFromTreeError(err)) return false;
    log(`[card-premises-auditor] WARN could not check ${ref} for ${relPath}: ${String(err.message).slice(0, 120)}`);
    return null;
  }
}

// Depth-bound the fetch (same reasoning as autofix-canary.js's
// markerExistsOnOriginMain): most CI checkouts are shallow, and an unbounded
// `git fetch origin main` from one pulls the whole repo instead of the delta.
function fetchOriginMain({ repo = REPO, log = () => {} } = {}) {
  const depthArgs = repoDepthArgs({ repoRoot: repo });
  try {
    // unbounded-fetch-ok: depthArgs IS the bound; the lint can't evaluate a spread.
    execFileSync('git', ['fetch', ...depthArgs, '--quiet', 'origin', 'main'], { cwd: repo, timeout: 30000, stdio: 'pipe' });
    return true;
  } catch (err) {
    log(`[card-premises-auditor] WARN could not fetch origin/main: ${String(err.message).slice(0, 120)}`);
    return false;
  }
}

// ── Vacuous-check detection (BRO-3378) ──────────────────────────────────────
// Everything above asks "can this command ever PASS?". This asks the opposite-
// polarity question nothing else in the pipeline asks: "can it ever FAIL?"
//
// A command that is already green on the pre-work tree cannot distinguish done
// from not-done, so re-running it at Done time proves nothing. That is the
// mechanism behind the recurring false-Done pattern: BRO-423 was armed with
// `test -f scripts/lib/check-merge-history.test.mjs` and sat "verified" for
// weeks while the checkout-speed fix it actually claimed was never re-proved.
// Measured on the 2026-09-15 live sweep: 124 open armed Linear cards name a
// `test -f`, and 40 of those name a path that already exists — and 19 of the
// enricher's own 85 logged `test -f` drafts named a path that was already in
// the repo when it drafted them (BRO-2837's by seven months).
//
// This is a rule about `test -f` ONLY, and the repo's own design intent is why
// it can be stated so flatly: autonomous-triage-core.js's NEW-ARTIFACT
// ALLOWANCE says the `test -f <path>` safe form "is by definition an assertion
// about a file the work is supposed to CREATE". A `test -f` naming a file that
// already exists therefore contradicts the documented purpose of the form it
// is written in. That same allowance is why an ABSENT path is emphatically not
// flagged here — naming the test you are about to write is correct, and
// vetoing it killed 3 in-scope cards in the 2026-07-26 live run.
//
// Deliberately NOT extended to the other safe forms, and none of them is
// silently declared healthy:
//   - `node --test`/`npx tsx --test` — NOT vacuous even when the file exists.
//     The file's CONTENTS change with the work, so the command's verdict can
//     change with it; that is the whole point of naming a colocated test.
//   - `npx tsc --noEmit`, `npx next lint` — green on main by construction, so
//     vacuous in spirit. Left out on purpose: the enricher's own prompt names
//     tsc as the honest "cannot infer" fallback, root tsconfig.json excludes
//     scripts/ entirely (so it says nothing at all about most cards), and
//     banning it converts weak-armed cards into unarmed ones with no telemetry
//     gain. Reported, not rejected — tracked as a follow-up.
//   - the generic `node scripts/audit-*.js` form — genuinely falsifiable
//     (a real audit can go red), so sweeping it in with tsc would be wrong.
const VACUOUS_TEST_F_SATISFIED = 'test-f-satisfied';
const VACUOUS_TEST_F_ARITY = 'test-f-arity';
// Not a defect — the absence of an answer. Returned so the two consumers can
// make OPPOSITE calls on it, which they must: a read-only audit must never
// accuse a card on an unresolved probe (auditVacuousChecks drops these), while
// the enricher is about to WRITE a command and cannot honestly claim it
// validated one (guardrail 2b defers the card to the next run instead). Folding
// this into a plain `null` is what made an oracle outage silently authorize new
// weak checks for the rest of a run — ship-check finding.
const VACUOUS_TEST_F_UNRESOLVED = 'test-f-unresolved';

/**
 * Is this command incapable of testing the claim it is attached to?
 *
 * Fail-open on every uncertainty, matching pathExistsOnOriginMain's own
 * null-on-transient-failure contract: a path `existsFn` cannot resolve this
 * run is never scored as vacuous, so a fetch blip can never manufacture a
 * "your acceptance criteria is worthless" verdict against a good card.
 *
 * @param {string} cmd
 * @param {(relPath:string)=>boolean|null} existsFn
 * @returns {{kind:string, polarity:string, paths:string[], reason:string}|null}
 */
function classifyVacuousCheck(cmd, existsFn) {
  const s = String(cmd || '').trim();
  if (!isTestFCommand(s)) return null;
  const paths = extractCheckFilePaths(s);
  if (!paths.length) return null;

  // SAFE_CHECK_FORMS' `test -f` regex is `((?: [\w@./-]+)+)` — it accepts more
  // than one operand, but `test -f a b` is a shell ARITY error ("too many
  // arguments", exit 2), not a two-file assertion. Such a command can never
  // pass, which makes it the mirror of the defect above rather than a vacuous
  // one; it is caught here because it is the same family ("this command does
  // not test the claim") and because nothing else in the pipeline looks for
  // it. `polarity` keeps the two apart for any reader or report that cares.
  if (paths.length > 1) {
    return {
      kind: VACUOUS_TEST_F_ARITY,
      polarity: 'never-passes',
      paths,
      reason: `\`test -f\` takes exactly one operand, but this names ${paths.length} (${paths.join(', ')}) — a shell arity error (exit 2), so the check can never pass`,
    };
  }

  const p = paths[0];
  const present = existsFn(p);
  // false = a to-be-created artifact. Correct, and the NEW-ARTIFACT ALLOWANCE
  // exists to protect exactly this — the only verdict that means "healthy".
  if (present === false) return null;
  if (present === null) {
    return {
      kind: VACUOUS_TEST_F_UNRESOLVED,
      polarity: 'unknown',
      paths,
      reason: `could not resolve \`${p}\` against origin/main this run, so whether \`test -f ${p}\` can ever fail is unknown`,
    };
  }
  return {
    kind: VACUOUS_TEST_F_SATISFIED,
    polarity: 'never-fails',
    paths,
    reason: `\`test -f ${p}\` already passes on origin/main, so re-running it at Done time cannot distinguish finished work from untouched work`,
  };
}

/**
 * Pure core, mirroring auditCardCheckPaths: which of these armed cards carry a
 * check that cannot test their claim?
 *
 * @param {Array<{id,name,url,cmd}>} cards
 * @param {(relPath:string)=>boolean|null} existsFn
 * @returns {Array<{id,name,url,cmd,kind,polarity,paths,reason}>}
 */
function auditVacuousChecks(cards, existsFn) {
  const flagged = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    const verdict = classifyVacuousCheck(card && card.cmd, existsFn);
    if (!verdict) continue;
    // A report is an accusation, so an unresolved probe is dropped here — same
    // fail-open contract auditCardCheckPaths keeps for a null existsFn result.
    // The enricher deliberately does the opposite with the same verdict.
    if (verdict.kind === VACUOUS_TEST_F_UNRESOLVED) continue;
    flagged.push({ id: card.id, name: card.name, url: card.url, cmd: card.cmd, ...verdict });
  }
  return flagged;
}

/**
 * Pure core: which of these armed cards name a `node --test`/`npx tsx
 * --test`/`test -f` file that `existsFn` reports as confirmed-missing?
 *
 * A path `existsFn` returns null for (unresolved this run) is never counted
 * as missing — same fail-open contract as the git-backed existsFn itself, so
 * a network blip can never manufacture a false "this card can never close".
 *
 * @param {Array<{id,name,url,cmd}>} cards
 * @param {(relPath:string)=>boolean|null} existsFn
 * @returns {Array<{id,name,url,cmd,missingPaths:string[]}>}
 */
function auditCardCheckPaths(cards, existsFn) {
  const flagged = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    const paths = extractCheckFilePaths(card && card.cmd);
    if (!paths.length) continue;
    // A multi-operand `test -f` is a SYNTAX error, not a missing-path problem:
    // `test -f a b` exits 2 whatever a and b are. Reporting "missing: a" for it
    // would be a misleading diagnosis AND would double-report the card, since
    // classifyVacuousCheck's arity branch already owns it — which is what made
    // the two buckets overlap instead of partitioning (ship-check finding).
    // Skipping here keeps arity in exactly one bucket, with the right cause.
    if (isTestFCommand(card.cmd) && paths.length > 1) continue;
    const missingPaths = paths.filter((p) => existsFn(p) === false);
    if (missingPaths.length) {
      flagged.push({ id: card.id, name: card.name, url: card.url, cmd: card.cmd, missingPaths });
    }
  }
  return flagged;
}

/**
 * I/O wrapper: fetches origin/main once, then checks every armed card's
 * `node --test`/`npx tsx --test`/`test -f` path against it. Skips the fetch
 * entirely when no card is a file-naming-shaped candidate (cheap common case).
 *
 * A failed fetch bails out to [] rather than falling through to whatever
 * origin/main happens to be cached locally: `git cat-file -e` reads the
 * local ref regardless of whether the fetch above actually refreshed it, so
 * proceeding on a fetch failure could report a file that landed upstream
 * SINCE the last successful fetch as "confirmed missing" — the exact false
 * positive this whole module exists to avoid (adversarial review finding).
 * Same fail-open contract as autofix-canary.js's markerExistsOnOriginMain:
 * "could not resolve this run" is never scored as a defect.
 */
function findCardCheckPathDefects(evaluatedCards, opts = {}) {
  const candidates = (Array.isArray(evaluatedCards) ? evaluatedCards : [])
    .filter((c) => c && c.armed && isCheckPathCommand(c.cmd));
  if (!candidates.length) return { missing: [], vacuous: [] };
  if (!fetchOriginMain(opts)) return { missing: [], vacuous: [] };
  const cache = new Map();
  const existsFn = (p) => {
    if (!cache.has(p)) cache.set(p, pathExistsOnOriginMain(p, opts));
    return cache.get(p);
  };
  // One fetch, one cache, both polarities (BRO-3378). Kept in a single pass on
  // purpose: the two questions are answered from the SAME existence facts, and
  // running them as two independent sweeps would double the fetch and let the
  // two reports disagree about a path that landed upstream between them.
  return {
    missing: auditCardCheckPaths(candidates, existsFn),
    vacuous: auditVacuousChecks(candidates, existsFn),
  };
}

// Back-compat wrapper: unchanged signature and return shape for the callers
// that only ever wanted the missing-path bucket.
function findCardsWithMissingCheckPaths(evaluatedCards, opts = {}) {
  return findCardCheckPathDefects(evaluatedCards, opts).missing;
}

module.exports = {
  isNodeTestCommand,
  isTestFCommand,
  isCheckPathCommand,
  extractCheckFilePaths,
  pathExistsOnOriginMain,
  fetchOriginMain,
  auditCardCheckPaths,
  findCardsWithMissingCheckPaths,
  classifyVacuousCheck,
  auditVacuousChecks,
  findCardCheckPathDefects,
  VACUOUS_TEST_F_SATISFIED,
  VACUOUS_TEST_F_ARITY,
  VACUOUS_TEST_F_UNRESOLVED,
  REPO,
};
