# STATE — card #1825 (manifest sort-order gate flapping CI)

## Done
- Root cause confirmed: CI check catches unsorted manifest AFTER commit,
  nothing enforced sort order at write time.
- Fix implemented and committed on branch `job/1825-mta88n91`
  (commit `8cf11b3c533`, pushed to origin):
  - `scripts/lib/test-manifest.js`: added `sortManifestFile()` + CLI
    `--fix` mode (sorts all 3 manifests in `MANIFESTS`, no-op if already
    sorted).
  - `scripts/hooks/pre-commit`: new step 3 — if any of the 3 manifest
    files are staged, runs `test-manifest.js --fix` and re-`git add`s
    the sorted result before the commit lands. Only re-stages manifests
    that were already staged.
- Verified end-to-end: staged a deliberately out-of-order manifest entry,
  ran a real commit through the hook (`git -c core.hooksPath=scripts/hooks
  commit`), confirmed the committed blob came out sorted
  (`git show HEAD:tests/unit-test-manifest.txt | sort -c`), then reset
  that throwaway commit and made the real one with just the two source
  file changes (manifest itself was untouched — already sorted).
- `node --test tests/unit/test-manifest-integrity.test.mjs` — 3/3 pass.
- `npx tsc --noEmit` — clean.
- `infra-review-scope.js` classifyPath confirms neither edited file is
  gated by CLAUDE.md rule 18 (`scripts/hooks/pre-commit` → not in scope;
  `scripts/lib/test-manifest.js` → 'shared' tier, warn-only, not
  blocking) — no /plan-review or /second-opinion review-gate record
  was required before this edit.

## Remaining (next command)
1. Merge to main and verify CI green:
   ```
   cd /Users/tompryor/Broadwayscore
   git checkout main && git pull origin main
   git merge job/1825-mta88n91 --no-edit
   scripts/lib/push-with-retry.sh origin main   # or the repo's documented retry loop
   ```
   Then watch the Test Suite run (get run id, use
   `scripts/lib/wait-for-run.sh <id>` — never `gh run watch`).
2. Run `/ship-check` on the diff (2 files, low risk) before/while doing (1)
   if not already run in this session.
3. Update/close the Notion card for #1825 (outcome: fix shipped in
   commit 8cf11b3c533; approach: pre-commit auto-sort instead of manual
   re-sort commits) and run `/wrap-up`.
4. Note for acceptance: this is a prevention mechanism, not something
   observable instantly — the real test is whether another
   "fix: re-sort tests/unit-test-manifest.txt" commit appears again
   after this lands. Consider a `RECHECK-AFTER:` stamp (e.g. 2026-09-02)
   per CLAUDE.md's async-effect rule if marking the card Done outright
   feels premature — but the mechanism itself (hook + CLI) is fully
   verified now, so the guard's existence can be closed once merged +
   CI green.
5. Delete this STATE.md once step 1-3 are complete (not needed after
   merge).

## Not done / explicitly out of scope
- Did not touch the manifest's *contents* — no live sort-order violation
  existed on this branch at time of fix (origin/main's own drift is a
  separate, already-self-healing symptom this hook prevents going
  forward).
- Did not add a `--fix` wiring for callers other than the pre-commit
  hook (e.g. CI auto-fix-and-recommit) — out of scope per the card's own
  "Option 1 is almost certainly the right scope" guidance.
