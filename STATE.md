# BRO-2989 — Session state (2026-09-08, headless, 10-min budget)

## Root cause found
`scripts/lib/needs-you-snapshot.js` correctly captures a crown session's
DECISION NEEDED via the workspace-mark-done.js hook, and the digest correctly
renders `buildNeedsYouSnapshot()`'s output — that pipeline is NOT broken.
The real gap: crown succession hand-offs (`launchCmuxSession({successorOf})`
in `scripts/lib/cmux-launch.js`) never retire a predecessor's ❓/state when a
successor takes over. Confirmed from LIVE `~/.claude/state/needs-you/*.json`
on this machine: the same ~handful of decisions (Cyrus Team Cloud $120/mo;
stranded worktrees) get asked fresh by 20+ sequential crown generations (v22
-> v48) across 3+ weeks, each with a new timestamp, wording NOT even fixed
generation to generation. So each generation's ask looked, on its own, like a
brand-new one-off — which is how 3 real generations (v25/v32/v33) went
unanswered long enough to be reaped as dead. Crown tabs are deliberately
exempt from auto-close (owner policy) so I did NOT touch closing/reaping —
fixed the SIGNAL instead.

## Done
- `scripts/lib/needs-you-snapshot.js`: added `collapseCrownLineages(pending)`
  — folds every LIVE crown-titled (`isCrownLaunchTitle`, from
  `crown-fanout-guard.js`) ❓ item into ONE digest row (freshest generation's
  question, using `extractVersion` from `crown-duplicate-detector.js`),
  annotated via `formatDetail()` with `supersededCount` + `pendingSinceTs`
  baked into the rendered `detail` string (the HTML renderer,
  `autonomous-email-render.js`'s `renderNamedDigestBlock`, only reads
  title/detail/url — no new fields needed there). Non-crown ❓ tabs pass
  through untouched, one row each. `buildNeedsYouSnapshot()` now calls
  `collapseCrownLineages` before building `items`, sorted by
  `pendingSinceTs || ts`.
  - Tried grouping by title-family (version token stripped, reusing
    crown-duplicate-detector.js's `titleFamilyKey`) FIRST — rejected, proven
    wrong by a failing test: real crown titles reword the question every
    hand-off, not just the version suffix, so family-key grouping
    under-merged (left every reworded generation as its own row). Collapsing
    ALL live crown ❓ tabs into one row is the correct fix given that reality.
  - Both exports (`collapseCrownLineages`, `formatDetail`) added to
    `module.exports`.
- `scripts/lib/needs-you-snapshot.test.mjs`: 2 new tests appended (3 crown
  generations + 1 unrelated ❓ tab collapse to exactly 2 rows, with the
  superseded refs absent and the surviving crown row carrying
  `supersededCount:2` + correct `pendingSinceTs`; a lone crown generation
  gets `supersededCount:0` and no false age annotation in its detail).
  **`node --test scripts/lib/needs-you-snapshot.test.mjs` — 8/8 pass**
  (verified, output captured this session).
- `node --check` + `require()` smoke-load both pass.

## Not done / next exact commands (in order)
1. **Lint + wider unit run** (not yet executed this session, budget ran out):
   ```
   npx eslint scripts/lib/needs-you-snapshot.js scripts/lib/needs-you-snapshot.test.mjs
   node --test scripts/lib/crown-fanout-guard.test.mjs scripts/lib/crown-duplicate-detector.test.mjs
   ```
   (confirms this change didn't disturb the two modules it imports from —
   both are pure-function reads only, no mutation, so expected: no change).
2. **Check any other caller of `pendingDecisions`/`buildNeedsYouSnapshot`
   output shape** — grep confirmed only `bsc-needs-you.js` and
   `send-morning-digest.js` consume it; neither reads `supersededCount`/
   `pendingSinceTs` directly (both only render `title`/`detail`), so no
   other file needs a change. Not re-verified with a fresh grep this run —
   do that first if resuming:
   ```
   grep -rn "buildNeedsYouSnapshot\|pendingDecisions" scripts/*.js scripts/lib/*.js
   ```
3. **Rule 18 pre-review**: `needs-you-snapshot.js` is `shared-lib` tier in
   `scripts/lib/infra-review-scope.js` (warn-only, not hard-blocked) —
   confirmed by reading that file's rule list before editing. A `/second-
   opinion` pass was STARTED on the plan (before the title-family bug was
   found and fixed) but never completed/recorded — the plan reviewed there is
   now stale (it proposed title-family grouping, which the tests proved
   wrong). If continuing, either re-run `/second-opinion` on the ACTUAL diff
   (`git diff`) or run:
   ```
   node scripts/lib/review-gate.mjs --query=record --reviewer=second-opinion --result=pass
   ```
   only after an actual review of the diff — do not skip this per rule 18's
   spirit even though the tier is warn-only, since the issue explicitly
   called out rule 18.
4. **Commit + push** (not yet done — this is the very next step):
   ```
   git add scripts/lib/needs-you-snapshot.js scripts/lib/needs-you-snapshot.test.mjs
   git commit -m "fix(needs-you): collapse sequential crown generations into one digest row (BRO-2989)"
   git push -u origin job/linear-BRO-2989-mtryvo7q
   ```
   Then open/update a PR, or merge to main per the global git workflow (pull
   --ff-only, merge, push-with-retry).
5. **Linear report** (blocking — do this once the above lands):
   ```
   node scripts/linear-session.js report --issue=BRO-2989 --status=in-review \
     --summary="Collapsed sequential crown-succession ❓ generations into one digest row (supersededCount + pendingSinceTs baked into detail text) so a decision open across N hand-offs reads as one aging row instead of N indistinguishable fresh asks — the actual mechanism that let v25/v32/v33 go unanswered. Did not touch tab auto-close (owner policy). 8/8 new+existing needs-you-snapshot tests pass." \
     --key-files="scripts/lib/needs-you-snapshot.js,scripts/lib/needs-you-snapshot.test.mjs" \
     --verification="node --test scripts/lib/needs-you-snapshot.test.mjs (8/8 pass)"
   ```
   Use `--status=done` instead of `in-review` only once pushed AND CI is
   green AND (if merged to main) deploy-irrelevant (this is a Node lib/test
   change, no Vercel build impact, but Test Suite CI must still be green —
   check with `gh run list --limit 5` before claiming done).

## Investigation answers (for whoever picks this up / final report)
- Q: "Does anything TELL the owner a crown is blocked?" — YES, the digest
  mechanism itself was already correct; the bug was volume/format (N
  indistinguishable fresh rows), not silence.
- Q: "Should a superseded generation be closed at re-crown time?" — NO, per
  established owner policy (crown tabs = manual close only,
  crown-duplicate-detector.js header). Fixed by collapsing the SIGNAL
  instead, which also structurally satisfies "a superseded generation does
  not outlive its successor" for the purposes the owner actually cares about
  (the digest) without touching tab lifecycle/auto-close at all.

## Worktree state
Branch `job/linear-BRO-2989-mtryvo7q`, 2 files modified (not yet committed
as of this STATE.md write — see step 4 above), working tree otherwise clean.
