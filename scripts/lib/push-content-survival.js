#!/usr/bin/env node
'use strict';
// Post-push CONTENT-survival check (task #619 P0).
//
// The bug: push-with-retry.sh can print "Push succeeded" with a genuine
// ref-update ("old..new main -> main") while the run's own commit's actual
// file content is NOT what's on origin/$PULL_BRANCH afterward — reproduced
// live twice in one session on the same one-line CLAUDE.md edit. Independent
// diagnosis both times: `git show origin/main:CLAUDE.md | wc -c` matched the
// PRE-EDIT byte count, i.e. the file was silently reverted to its OLD content
// somewhere inside this run's fetch->rebase/merge->push cycle.
//
// Neither existing guard catches this:
//   - check-post-rebase-survival.js only tracks ADDED files (--diff-filter=A)
//     and explicitly no-ops when the run's commit only MODIFIES existing
//     files (exactly the CLAUDE.md case — a byte-cap trim is a pure
//     modification, nothing added).
//   - push-rebase-progress.js's no-op-rebase guard only proves the FETCHED
//     remote tip became an ancestor of HEAD — a completely different (and
//     insufficient) direction. It says nothing about whether a MODIFIED
//     file's content is what our commit intended, since a rebase/merge/
//     cherry-pick can auto-resolve a conflict by discarding our side of a
//     single file while still correctly integrating everything else.
//   - A naive "is our original commit SHA an ancestor of origin" check (the
//     card's own manual diagnostic) is unusable as an automated guard: any
//     successful rebase replays commits into BRAND NEW objects with
//     different SHAs, so that check would false-positive on every clean
//     rebase, not just a lossy one.
//
// This guard instead compares file CONTENT (blob hashes) at three points for
// every file the run's commit(s) actually MODIFIED (added files are already
// covered by check-post-rebase-survival.js):
//   base  = the file's content just before the run's own commit(s)
//   local = the file's content IN the run's own commit (what we intended)
//   final = the file's content at the ref we just believe we pushed
//
// - final === local            -> survived: exactly what we intended.
// - final === base (!== local) -> REVERTED: our edit is provably gone — this
//   is the exact signature from the incident's own manual diagnosis.
// - local === base              -> unchanged: our commit didn't actually
//   change this file's content (e.g. a mode-only change); nothing at risk.
// - anything else                -> ambiguous: content diverged from both —
//   most likely a legitimate 3-way merge that combined our edit with an
//   unrelated concurrent change to the same file. NOT flagged as a failure
//   (this file class is common on a busy shared main and flagging it would
//   make the guard unusable), but callers should still surface it for
//   visibility.

/**
 * @param {{baseBlob: string|null, localBlob: string|null, finalBlob: string|null}} blobs
 * @returns {'survived'|'unchanged'|'reverted'|'ambiguous'}
 */
function classifyFileSurvival({ baseBlob, localBlob, finalBlob }) {
  if (localBlob === baseBlob) return 'unchanged';
  if (finalBlob === localBlob) return 'survived';
  if (finalBlob === baseBlob) return 'reverted';
  return 'ambiguous';
}

// Task #833: 'ambiguous' (final content matches neither base nor local) was
// treated as always-OK — the reasoning being "probably a legitimate 3-way
// merge that combined our edit with an unrelated concurrent change". That
// reasoning has a hole: under heavy push-mutex contention (many sessions
// racing the SAME shared checkout, mutex fails open after its 900s timeout —
// see push-mutex.sh), a concurrent write to the SAME file can land in a way
// that discards our specific hunk while still changing the file from its
// pre-edit base — e.g. a rebase/merge/reset from a sibling process touching
// the same file elsewhere. File-level blob comparison alone can't tell "both
// edits survived" from "our edit was clobbered by an unrelated one" once ANY
// other change also touches the file. Reproduced live: task #833 (commit
// d405dcfbe03, a 2-line addition to .github/workflows/test.yml) vanished
// from origin/main with push-with-retry.sh reporting success — the file's
// final content differed from both base and local, so the old classifier
// waved it through as 'ambiguous'.
//
// This extracts the LINES our own commit(s) added (from the base->local
// patch) and checks whether every one of them is still present, verbatim,
// in the final content. This directly answers "is MY change there" instead
// of inferring it from whole-file identity, and works regardless of what
// else changed in the file.

// Retained for its own direct unit tests only — the CLI no longer uses this
// as the source of `addedLines` (see computeAddedLines below, task BRO-2449).
// Diff-text '+' lines can include lines base and local AGREE on verbatim,
// re-emitted as a redundant -/+ pair purely because git's diff algorithm
// realigned hunks elsewhere in the same file. computeAddedLines answers the
// same question directly from full file content instead.
/**
 * @param {string} patch unified diff text for a single file (base..local)
 * @returns {string[]} non-blank lines the patch ADDED, with the leading '+' stripped
 */
function extractAddedLines(patch) {
  if (!patch) return [];
  return patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .filter((l) => l.trim().length > 0);
}

// Normalize a line for comparison: trim + collapse internal whitespace runs.
// Plain .trim() only strips leading/trailing whitespace, so a concurrent
// formatter that re-indents or collapses double-spaces on OUR OWN added line
// (common for YAML/JSON auto-formatters) would make a byte-exact comparison
// report our content as missing — a false 'reverted' on a genuinely-safe
// 3-way merge (adversarial review finding, task #833 follow-up). Collapsing
// internal whitespace keeps the check meaningful (real content differences
// still fail) while tolerating pure reformatting.
function normalizeLine(line) {
  return line.trim().replace(/\s+/g, ' ');
}

// Multiset of normalized non-blank lines in `content`, keyed by normalized
// text -> occurrence count.
function lineCounts(content) {
  const counts = new Map();
  for (const line of (content || '').split('\n')) {
    const n = normalizeLine(line);
    if (!n) continue;
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  return counts;
}

/**
 * @param {string[]} addedLines lines our commit(s) genuinely added beyond base
 *   (from computeAddedLines — a net-new occurrence per repeated entry)
 * @param {string|null} baseContent the file's full content BEFORE our commit (pre-edit)
 * @param {string|null} finalContent the file's full content at the ref we just pushed
 * @returns {boolean} true if OUR added lines are still present in finalContent BEYOND
 *   whatever identical lines already existed at base — i.e. not just "this text
 *   appears somewhere in the file" but "an occurrence attributable to our commit is
 *   still there". A pure set-membership check would report 'survived' whenever an
 *   added line's text also happens to occur elsewhere in the file (adversarial
 *   review finding, task #833 follow-up: plausible for repetitive CI-YAML
 *   boilerplate) even when the actual line our commit added was clobbered. Fails
 *   OPEN (true) when there is nothing to check (pure deletion) or finalContent is
 *   unavailable, matching this guard's existing fail-open conventions elsewhere.
 */
function addedLinesSurvived(addedLines, baseContent, finalContent) {
  if (!addedLines || addedLines.length === 0) return true;
  if (finalContent == null) return true;
  const added = new Map();
  for (const l of addedLines) {
    const n = normalizeLine(l);
    if (!n) continue;
    added.set(n, (added.get(n) || 0) + 1);
  }
  const base = lineCounts(baseContent);
  const final = lineCounts(finalContent);
  for (const [line, addedCount] of added) {
    const required = (base.get(line) || 0) + addedCount;
    if ((final.get(line) || 0) < required) return false;
  }
  return true;
}

// Task BRO-2449: a stale branch (forked long before an unrelated main-side
// improvement landed) was reported FAILED/REVERTED for a file where nothing
// was actually clobbered. Root cause: the old CLI wiring fed addedLinesSurvived
// lines pulled from extractAddedLines(patch) — raw '+' lines out of the
// base..local unified diff TEXT. When a branch's commit(s) touch OTHER parts
// of the same file, git's diff algorithm can re-emit a line that base and
// local AGREE on verbatim as a redundant -/+ pair, purely from hunk
// realignment. That line was never genuinely new content from this branch —
// but if origin/main has since legitimately replaced that same
// never-touched-by-us line with an improved version, addedLinesSurvived()
// required it to still be present beyond base's own count, and flagged
// 'reverted' for content that was never ours to lose. Live incident
// (2026-08-26): job/linear-BRO-736 flagged scripts/lib/url-discovery.js this
// way — the branch's only "added" line was the pre-#983 form of a line main
// had since replaced with a 9-line worktree-fallback block; nothing was
// clobbered.
//
// Fix: compute genuinely-added lines from CONTENT (base vs local full text),
// not diff TEXT. A line counts as added only if local has strictly more
// occurrences of it than base did — immune to diff-algorithm realignment
// noise, since it's derived straight from the content-addressed blobs
// (baseBlob/localBlob) rather than a rendered patch. This intentionally does
// NOT just skip any line that merely appears somewhere in base (that would
// break the addedLinesSurvived 'duplicate-line' guard below: a line that
// already exists once in the file and is genuinely duplicated by this
// branch, where that specific new copy gets clobbered, must still be caught)
// — it nets the occurrence delta instead, which handles both shapes.
//
// Known scope limit (ship-check adversarial finding, not a regression — see
// below): a same-commit MOVE of a line (removed from one spot, re-added
// elsewhere, net delta zero) is invisible to this net-delta check, same as it
// would be to a pure content-multiset diff of the whole file. If a concurrent
// edit then drops that moved line entirely, this stays 'ambiguous' (visible
// AMBIGUOUS warning, not silently swallowed) rather than 'reverted'. This is
// the correct scope, not a gap: this guard verifies "did content OUR COMMIT
// actually contributed survive", not "did content our commit merely carried
// forward from base survive" — the latter is base's/main's own content, not
// ours to lose. A diff-TEXT check can't fix this either: a real move produces
// the exact same -/+ shape as the stale-branch realignment artifact above, so
// "fix" would just reintroduce the false positive this function exists to
// remove (both cases are genuinely indistinguishable from content alone).
/**
 * @param {string|null} baseContent full content just before the run's commit(s)
 * @param {string|null} localContent full content IN the run's own commit
 * @returns {string[]} lines local has strictly more occurrences of than base,
 *   each repeated once per net-new occurrence (e.g. base has 1, local has 3
 *   -> that line appears twice in the result). Empty when localContent is
 *   unavailable (e.g. file absent from the run's own commit).
 */
function computeAddedLines(baseContent, localContent) {
  if (localContent == null) return [];
  const base = lineCounts(baseContent);
  const local = lineCounts(localContent);
  const result = [];
  for (const [line, localCount] of local) {
    const net = localCount - (base.get(line) || 0);
    for (let i = 0; i < net; i++) result.push(line);
  }
  return result;
}

/**
 * Deep variant of classifyFileSurvival: only does extra work for the
 * 'ambiguous' bucket (survived/reverted/unchanged are already decided by the
 * cheap blob comparison). Downgrades 'ambiguous' to 'reverted' when our own
 * added content demonstrably did not make it into the final file.
 *
 * 'superseded' (Opening Night Poller incident, Aug 7-9 2026 — 6 runs red):
 * when sibling pipelines (Collect Review Texts / Gather Review Data / the
 * poller) collect the SAME review, the loser's rebase integrates the sibling's
 * already-pushed version of the file, so the loser's exact added lines are
 * absent from its own rebased tree — and the added-lines downgrade above
 * declared 'reverted' deterministically on every retry (the push itself had
 * landed; runs 31221911308/31334956731 et al. went red 5x each for nothing).
 * The distinguisher is `pushedBlob` — the file's content in the commit WE
 * JUST PUSHED. If origin's final content is exactly what our own resolution
 * pushed (pushedBlob === finalBlob) and it is NOT the pre-edit base (that
 * case stays 'reverted' via the cheap classifier — the true #619 signature),
 * then nothing clobbered us after the push: our own rebase chose a concurrent
 * fresh version over ours. Callers warn loudly but must not fail. Both nulls
 * guard: a file DELETED at final (finalBlob null) with an unresolvable
 * pushed-sha (pushedBlob null) must not satisfy null === null.
 * @param {{baseBlob: string|null, localBlob: string|null, finalBlob: string|null,
 *           pushedBlob?: string|null,
 *           addedLines?: string[], baseContent?: string|null, finalContent?: string|null}} entry
 * @returns {'survived'|'unchanged'|'reverted'|'ambiguous'|'superseded'}
 */
function classifyFileSurvivalDeep(entry) {
  const base = classifyFileSurvival(entry);
  if (base !== 'ambiguous') return base;
  if (addedLinesSurvived(entry.addedLines, entry.baseContent, entry.finalContent)) return 'ambiguous';
  if (entry.pushedBlob != null && entry.finalBlob != null && entry.pushedBlob === entry.finalBlob) return 'superseded';
  return 'reverted';
}

/**
 * @param {Array<{file: string, baseBlob: string|null, localBlob: string|null, finalBlob: string|null}>} entries
 * @returns {Array<{file: string, status: string}>}
 */
function classifyAll(entries) {
  return entries.map((e) => ({ file: e.file, status: classifyFileSurvival(e) }));
}

function anyReverted(classified) {
  return classified.some((c) => c.status === 'reverted');
}

// Task BRO-2500: a second false-positive variant BRO-2449's fork-point
// scoping does not cover. That fix addressed a STALE BRANCH (lines the
// branch never touched, which main has since legitimately replaced) — the
// missing lines were never genuinely the branch's to lose, so scoping them
// out of addedLines suppresses the alarm.
//
// This variant is structurally different and can't be fixed by scoping
// addedLines more carefully, because there's nothing wrong with addedLines
// here: a small number of known files have MANY independent writers (or, for
// deploy-watermark.json below, a single writer whose entire job is to
// overwrite the file with a fresh snapshot on every run) such that BOTH the
// branch and main routinely diverge from base in the SAME push window,
// neither at the other's expense. addedLinesSurvived() correctly reports
// "the branch's added lines are not in final" — they really aren't — but
// that's not evidence of a clobber for these specific files, it's the file
// doing exactly what it exists to do. Per the ticket: these files need to be
// excluded from the check entirely, not scored more cleverly — any
// set/multiset comparison would still have to special-case "both sides can
// add without either being wrong", which is just this same exclusion with
// extra steps.
//
// Shape follows scripts/lib/ledger-coverage-exemptions.js's EXEMPTIONS /
// scripts/lib/audit-ledger-merge-attrs.js's EXEMPT_LEDGERS convention (a
// {file, reason} object array with a dated justification per entry) rather
// than a bare path list — this codebase already solves "documented exception
// to an automated check" this way twice, and a bare list would have nowhere
// to record that deploy-watermark.json is exempt for a DIFFERENT reason than
// the other three (see its own entry below).
//
// Matched by exact file path (not suffix): `git diff --name-only` always
// reports repo-root-relative paths, and no real caller of this CLI passes
// --path-prefix today (verified: grepped every scripts/lib/push-with-retry.sh
// and scripts/merge-worktree-to-main.sh call site) — suffix matching would
// only add a future basename-collision risk for zero present benefit.
//
// Drift guard: scripts/lib/push-content-survival.test.mjs's "stays in sync
// with core-data-merge-registry.js" test fails if the registry ever adds a
// real merge fn / status:'active' entry for one of the three registry-cited
// paths below — that would mean the file is no longer "genuinely
// unreconciled by design" and this exemption should be revisited alongside
// it, not silently keep excluding a file that now has real coverage.
const CONTENT_SURVIVAL_EXEMPT_LEDGERS = [
  {
    file: 'data/audit/alert-ledger.json',
    reason:
      '2026-08-26 (BRO-2500): 12 independent writers, deliberately excluded from ' +
      "core-data-merge-registry.js's active/merge-fn coverage (see its \"NOT added, " +
      'deliberately\" comment) because divergence here is expected and benign, not an ' +
      'error to reconcile away. Live incident: merging origin/job/linear-BRO-45-mtapwjad ' +
      'reported REVERTED — 18 lines only on the branch, 23 lines only on main, both grown ' +
      'independently, nothing clobbered.',
  },
  {
    file: 'data/audit/alert-digest-queue.json',
    reason: "2026-08-26 (BRO-2500): same shape and same registry comment as alert-ledger.json above — 8 independent writers.",
  },
  {
    file: 'data/audit/alert-router-attempts.jsonl',
    reason: "2026-08-26 (BRO-2500): same shape and same registry comment as alert-ledger.json above — 3 independent writers.",
  },
  {
    file: 'data/audit/deploy-watermark.json',
    reason:
      '2026-08-26 (BRO-2500): the OTHER file flagged reverted in the same live incident as ' +
      'alert-ledger.json above, but for a different underlying reason — not an append-only ' +
      'ledger, a small whole-object snapshot ({showCount, reviewCount, updatedAt}) that ' +
      'update-deploy-watermark.yml fully overwrites on every deploy. There is no "our added ' +
      "lines must survive\" invariant to check for a full-overwrite file: its content is " +
      'EXPECTED to differ between any two arbitrary points in time regardless of which ref ' +
      'last touched it, so every touch looks like the same false-positive shape.',
  },
];

/**
 * @param {string} file repo-relative path as reported by `git diff --name-only`
 * @returns {boolean} true if this file is a documented exception that
 *   content-survival should not attempt to classify at all
 */
function isContentSurvivalExempt(file) {
  return CONTENT_SURVIVAL_EXEMPT_LEDGERS.some((e) => e.file === file);
}

module.exports = {
  classifyFileSurvival,
  classifyFileSurvivalDeep,
  extractAddedLines,
  computeAddedLines,
  addedLinesSurvived,
  classifyAll,
  anyReverted,
  CONTENT_SURVIVAL_EXEMPT_LEDGERS,
  isContentSurvivalExempt,
};

// ── CLI ───────────────────────────────────────────────────────────────────
// Usage: node push-content-survival.js --before-sha=<sha> --base-sha=<sha>
//          --check-ref=<ref> [--path-prefix=<prefix>] [--pushed-sha=<sha>]
//
// --pushed-sha (optional): the commit the caller just pushed (post-conflict-
// resolution HEAD, or the Git Data API fallback's new SHA). Enables the
// 'superseded' classification — see classifyFileSurvivalDeep. Absent: exact
// pre-existing behavior.
//
// Exit codes: 0 = OK (nothing reverted), 1 = at least one file REVERTED,
// 2 = invalid args / git failure (fail-open — caller should treat as "skip",
// same convention as check-post-rebase-survival.js).
if (require.main === module) {
  const { execFileSync } = require('child_process');

  const arg = (name) => {
    const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
    return a ? a.split('=').slice(1).join('=') : null;
  };
  const gitTry = (args) => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', timeout: 30_000 }).trim();
    } catch {
      return null;
    }
  };

  const beforeSha = arg('before-sha');
  const baseSha = arg('base-sha');
  const checkRef = arg('check-ref');
  const pathPrefix = arg('path-prefix') || '';
  const pushedSha = arg('pushed-sha');

  if (!beforeSha || !baseSha || !checkRef) {
    console.log('SKIP (missing --before-sha/--base-sha/--check-ref)');
    process.exit(0);
  }

  let modifiedFiles;
  try {
    // MT, not just M (ship-check/Codex finding): the fault-injection test that
    // proves resolve_conflicts()'s default arm is fixed uses a TYPE-CHANGE
    // conflict (regular file <-> symlink) — the one structural shape proven,
    // by direct git experimentation, to survive -X ours/-X theirs
    // auto-resolution. Without T here, this second-layer check would report
    // "no modified files to check" on exactly that class, leaving it covered
    // ONLY by the resolve_conflicts() fix and not by this independent guard.
    const diffArgs = ['diff', '--name-only', '--diff-filter=MT', `${baseSha}..${beforeSha}`];
    if (pathPrefix) diffArgs.push('--', pathPrefix);
    modifiedFiles = execFileSync('git', diffArgs, { encoding: 'utf8', timeout: 30_000 })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    console.log(`SKIP (git diff failed: ${e.message})`);
    process.exit(0);
  }

  // This exact vacuous-diff case (no MODIFIED/TYPE-CHANGED files at all) must
  // print the literal "no modified files to check" text UNCHANGED and BEFORE
  // exemption filtering: merge-worktree-to-main.sh pattern-matches that exact
  // substring to print its own "compared NOTHING — check by hand" warning
  // when the fork-point scoping itself went empty (a genuinely different,
  // pre-existing failure mode this fix does not touch).
  if (modifiedFiles.length === 0) {
    console.log('OK — no modified files to check');
    process.exit(0);
  }

  // Task BRO-2500: documented exemptions (append-only/full-overwrite
  // multi-writer files — see CONTENT_SURVIVAL_EXEMPT_LEDGERS) are filtered
  // out here, AFTER the vacuous-diff check above, deliberately NOT reusing
  // its "no modified files to check" text even when every remaining file
  // turns out to be exempt. Collapsing into that literal string was tried
  // and reverted (ship-check finding): merge-worktree-to-main.sh's
  // vacuous-guard case-match fires on that substring whenever VERIFY_FILES
  // is non-empty, and VERIFY_FILES virtually always contains an exempt
  // ledger a branch actually touched — so reusing the string would replace
  // the #619 hard-failure false alarm this ticket exists to remove with a
  // softer, but still spurious, "check by hand" warning on the SAME files,
  // undermining the exact goal. A distinct message here means the caller
  // simply prints nothing extra, since there IS nothing to manually verify.
  const exemptFiles = modifiedFiles.filter((f) => isContentSurvivalExempt(f));
  for (const f of exemptFiles) {
    const entry = CONTENT_SURVIVAL_EXEMPT_LEDGERS.find((e) => e.file === f);
    console.log(`[content-survival] EXCLUDED (documented exemption, BRO-2500): ${f} — ${entry.reason}`);
  }
  modifiedFiles = modifiedFiles.filter((f) => !isContentSurvivalExempt(f));

  if (modifiedFiles.length === 0) {
    console.log(`OK — ${exemptFiles.length} modified file(s) all documented exemptions, nothing left to check`);
    process.exit(0);
  }

  const entries = modifiedFiles.map((file) => ({
    file,
    baseBlob: gitTry(['rev-parse', `${baseSha}:${file}`]),
    localBlob: gitTry(['rev-parse', `${beforeSha}:${file}`]),
    finalBlob: gitTry(['rev-parse', `${checkRef}:${file}`]),
  }));

  // Deep-check only the 'ambiguous' bucket (task #833): survived/reverted/
  // unchanged are already fully decided by the cheap blob comparison, so
  // only pay for the extra file-content reads where they matter.
  //
  // Content is read via the ALREADY-RESOLVED blob SHAs (e.baseBlob/e.localBlob/
  // e.finalBlob), not by re-resolving `checkRef:file` a second time (adversarial review
  // finding, task #833 follow-up): `checkRef` is a moving ref
  // (origin/$PULL_BRANCH), so a second `git show checkRef:file` call could
  // observe a DIFFERENT commit than the one `finalBlob` was rev-parsed
  // against if the local tracking ref advances between the two calls (e.g. a
  // concurrent fetch on a shared checkout — the exact contention class
  // push-mutex.sh exists to guard against). A blob SHA is content-addressed
  // and immutable, so `git show <blob-sha>` is guaranteed to return the exact
  // bytes that blob was computed from, eliminating the race entirely.
  for (const e of entries) {
    if (classifyFileSurvival(e) !== 'ambiguous') continue;
    e.baseContent = e.baseBlob ? gitTry(['show', e.baseBlob]) : null;
    const localContent = e.localBlob ? gitTry(['show', e.localBlob]) : null;
    e.addedLines = computeAddedLines(e.baseContent, localContent);
    e.finalContent = e.finalBlob ? gitTry(['show', e.finalBlob]) : null;
    e.pushedBlob = pushedSha ? gitTry(['rev-parse', `${pushedSha}:${e.file}`]) : null;
  }

  const classified = entries.map((e) => ({ file: e.file, status: classifyFileSurvivalDeep(e) }));
  const reverted = classified.filter((c) => c.status === 'reverted');
  const ambiguous = classified.filter((c) => c.status === 'ambiguous');
  const superseded = classified.filter((c) => c.status === 'superseded');
  const revertedFromAmbiguous = new Set(
    entries.filter((e) => classifyFileSurvival(e) === 'ambiguous' && classifyFileSurvivalDeep(e) === 'reverted').map((e) => e.file)
  );

  for (const c of ambiguous) {
    console.log(`[content-survival] AMBIGUOUS (likely legitimate concurrent merge, our own added lines confirmed present): ${c.file}`);
  }
  for (const c of superseded) {
    console.log(`[content-survival] SUPERSEDED: ${c.file} — our own conflict resolution integrated a concurrent fresh version of this file instead of ours (sibling-pipeline collision, e.g. two collectors pushing the same review). What we pushed IS what's on ${checkRef}; nothing clobbered us post-push. Not failing — but our version of this file was not the one that won.`);
    // Inventory exactly which of our added lines did NOT land (adversarial
    // review finding: without this, content our commit uniquely carried —
    // beyond what the winning version also had — would vanish with only a
    // generic warning). Capped so a large collected fullText doesn't flood
    // the job log; the file path + count is enough to re-collect.
    const e = entries.find((en) => en.file === c.file);
    const lost = (e && e.addedLines) || [];
    for (const line of lost.slice(0, 5)) {
      console.log(`[content-survival]   lost line: ${line.length > 200 ? line.slice(0, 200) + '…' : line}`);
    }
    if (lost.length > 5) console.log(`[content-survival]   … and ${lost.length - 5} more added line(s) not in the winning version`);
    console.log(`::warning::content-survival: ${c.file} superseded — ${lost.length} of our added line(s) are not in the version that won (integrated during our own conflict resolution; nothing clobbered post-push). If this file's content matters beyond what siblings collect, re-collect it.`);
  }

  if (reverted.length > 0) {
    console.error(`[content-survival] FAILED — ${reverted.length} file(s) silently REVERTED to pre-edit content on ${checkRef}:`);
    for (const c of reverted) {
      const note = revertedFromAmbiguous.has(c.file)
        ? ' (task #833 signature: final content matches neither base nor local, but our added lines are missing — clobbered by a concurrent write, not a legitimate merge)'
        : '';
      console.error(`  - ${c.file}${note}`);
    }
    console.error('  This is the task #619 signature: a push reported success, but the run\'s own');
    console.error('  content change is not on the ref we just pushed. Some conflict-resolution step');
    console.error('  in this run discarded it in favour of the pre-existing/remote version.');
    process.exit(1);
  }

  const confirmed = classified.length - ambiguous.length - superseded.length;
  const supersededNote = superseded.length > 0 ? `, ${superseded.length} superseded (see warnings above)` : '';
  console.log(`OK — ${confirmed}/${classified.length} modified file(s) confirmed surviving on ${checkRef}${supersededNote}`);
  process.exit(0);
}
