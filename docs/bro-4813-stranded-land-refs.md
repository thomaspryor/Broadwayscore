# BRO-4813 stranded land refs: Outcome

Triage date: 2026-10-14. Compared against the runner-provided origin/main at `87f7cbd86e9395120f3c9e1252e05e3dae4d32bd` (HEAD was the same commit). The 24-ref card title expands to **29 explicit names**: **28 present, 1 absent**. A second live ref listing confirmed that none of these tips changed during the audit.

**Outcome: 27 refs safe to delete at the recorded tips, 1 unlanded ref to retain, 1 already absent.** No refs were deleted, rebased, committed, pushed or landed. This unattended run permits working-tree changes only and prohibits workflow edits and Linear writes.

Changed files: this report and a narrow `.gitignore` exception so the runner retains it. Production code, workflows and data were left unchanged.

## Method and main status

For every present ref, ran `git diff <main>...<tip>` and inspected its changed paths and branch commits; ran `git cherry <main> <tip>` to distinguish rebased equivalents from genuinely different patches. For unmatched patches, compared their behavior and data with current main. Age, a passing stranded-ref unit test, and an unmatched cherry patch alone were not used as deletion evidence.

The checkout Git metadata is read-only (`cannot open .../.git/worktrees/codex-runner/FETCH_HEAD: Read-only file system`). A temporary Git mirror inside this checkout enabled comparisons without changing the worktree branch or remote refs. It was removed after the audit. All comparisons below use the pinned main SHA above rather than a moving remote main.

Prevention already landed: `git log <main> -S 'land/bro-N-<slug>' --oneline -5 -- .claude/CLOUD.md` identifies `49f286f321a` (BRO-4802). `.claude/CLOUD.md:39` instructs landing to `land/bro-N-<slug>` and explains card routing. No duplicate prevention edit is needed. The acceptance command already passed 19/19 on this exact main before work.

## Safe deletion list for a Mac session

Re-fetch and verify each full tip below before deleting. A moved ref needs a new comparison. The absent ref needs no deletion. Retain the broadcast-draft ref described below.

| Ref | Audited tip | Evidence |
| --- | --- | --- |
| `land/font-selfhost` | `087f3ee72b6ae35be1f0b4d055a9b08fdcb46f6e` | Superseded by font-selfhost-v4; its complete patch is on main. |
| `land/font-selfhost-v2` | `cbdb82a8a7b537055804d23c3678acad8c6aba25` | Superseded by v4; guard logic is identical after moving scripts/check-font-integrity.js to scripts/lib/ (only help/import paths differ). |
| `land/font-selfhost-v3` | `bccc6f39683b070c8d48f72d28ca10f641f1a050` | Superseded by v4, including the move to scripts/lib/. |
| `land/font-selfhost-v4` | `e6ce8ee6837b9abc1299b53029eac77fc5ba9bd7` | All 1 non-merge patches have equivalents on main (git cherry returns only '-'). |
| `land/reddit-opening-posts` | `5a1939a805b98f34878cb55f766de4a9bfd159d3` | All 2 non-merge patches have equivalents on main (git cherry returns only '-'). |
| `land/reddit-opening-posts-2` | `7b6324fa1cc484f147af39a904651293dd76b4e9` | All 3 non-merge patches have equivalents on main (git cherry returns only '-'). |
| `land/reddit-post-email` | `7af2b99c785785b7c98f504663554b064bf5fa45` | All 3 non-merge patches have equivalents on main (git cherry returns only '-'). |
| `land/reddit-post-email-2` | `e2482d1480a91be8b3926a22cc7674aa6c2e49f7` | All 3 non-merge patches have equivalents on main (git cherry returns only '-'). |
| `land/tour-phase-d` | `d7af494b41a4957ad98e308ef4123c4798078c0e` | All 3 non-merge patches have equivalents on main (git cherry returns only '-'). |
| `land/tour-roundup-suggest` | `efa266948ce85b1524c81b230d97bb9b90db4c08` | All 7 non-merge patches have equivalents on main (git cherry returns only '-'). |
| `land/audit-agent-batch-1` | `343c247e358d5ba9e936ba30fe9e9106a5e6c787` | All 16 non-merge patches have equivalents on main (git cherry returns only '-'). |
| `land/audit-agent-batch-2` | `041fa52085f6936e3a1be4ed386dfe7a8a647a04` | 16 equivalent patches; the remaining CI fixes are already present, including diacritic folding, venue annotations, cleanup retries and structural test exemptions. The public critic-alias template is now gitignored. |
| `land/audit-agent-batch-4` | `58d767ed5d6855791e2adc060ca5da01f40a16e6` | All 1 non-merge patches have equivalents on main (git cherry returns only '-'). |
| `land/audit-owe-staging-merge` | `201311b350201e1b37850f108b4372ca19277388` | 10 equivalent patches; all 53 log additions from 6510edbbba2 are exactly present on main (49 promoted IDs). The drained staging array is identical. The last-promotion snapshot has since advanced; do not restore it. |
| `land/audit-owe-staging-merge-2` | `ac5a4cf454fe380dc1d049d7b6edd137b2b37e03` | All 4 non-merge patches have equivalents on main (git cherry returns only '-'). |
| `land/audit-s0-safety-rails` | `b835f10d83e459c7a631c3e51163c73a857b3a5b` | All 12 non-merge patches have equivalents on main (git cherry returns only '-'). |
| `land/audit-inflight-gate` | `5151069ea7d549659aba1dc416b2d117bc02ba00` | Other two patches equivalent; INFLIGHT hook, cloud instructions, wrap-up instructions and regression tests are present and extended on main. |
| `land/audit-inflight-gate-2` | `f31d117bbdaf35affff3ac0761daeedcc977b11a` | Same INFLIGHT behavior already present and extended on main. |
| `land/nyt-pick-opening-night` | `fb1f4224bd4b750e76546189e7d5b0121a6c4291` | NYT refresh helper and max-pages parser are present; poller calls helper at line 802 and refresh at line 809. Current tests pass. |
| `land/opening-night-guards-2026-09-29` | `f90798bd7a96e97db6adca8fc716e965f7e34bd1` | All 1 non-merge patches have equivalents on main (git cherry returns only '-'). |
| `land/school-pictures-2023` | `6a6b8c811d5edcf980c450da6c3fefafb9ba8c25` | All 1 non-merge patches have equivalents on main (git cherry returns only '-'). |
| `land/stale-excerpt-rescore` | `f86f97c66fd1df15352c2413c088cbead620312a` | NYT refresh plus human/extracted-score and completed-rescore guards are present; llm-ensemble-score.yml lines 615-618 call the stale-input audit. Current tests pass. |
| `land/main-red-tour-orphan` | `bed6622f115acd8108d2f76f43a1e5cfe3f499a9` | run-age-label registration equivalent; tour-links invariant was independently fixed under BRO-4650. Current test compares all Broadway productions and permits newly added tours. |
| `land/collector-wp-reverify` | `7eec83def520136e482b8ce52554beff3f4e64eb` | All 1 non-merge patches have equivalents on main (git cherry returns only '-'). |
| `land/cross-market-london-selfheal` | `21a9b6844b7426d72026e741da2d1f43e7602b46` | All 1 non-merge patches have equivalents on main (git cherry returns only '-'). |
| `land/cloud-pick-autoparked` | `b388423836b70d77be60c7d9210f3b1ed2456c8c` | Empty three-dot diff (0 files): its merge base already has the complete tip tree. Historical cherry output has 3 unmatched patches, but there is no remaining net change. |
| `land/audience-london-broadwaycom` | `363a44f7d0da385da499112b09771c8fe530bd85` | All 4 non-merge patches have equivalents on main (git cherry returns only '-'). |

## Retain: unlanded broadcast workflow

`land/celebrity-autobiography-broadcast-draft`, tip `d31c636c324a5dab77718e725bc893d1d4f1c6d5`, has one unmatched patch, modifying only `.github/workflows/opening-night-broadcast.yml`. Main has no `draft_only` input, and `git log <main> -S 'draft_only' --oneline -5 -- .github/workflows/opening-night-broadcast.yml` returns no commits.

The patch adds draft-only dispatch, skips the preview email and owner notification, passes `--force-create-draft`, bypasses readiness/checklist/drift/orphan gating, and suppresses mobile push notifications. It needs a fresh workflow and broadcast-safety review against the current create_draft/deadline flow. It must not be treated as already landed or safe to delete.

`git merge-tree --write-tree <main> d31c636c324a5dab77718e725bc893d1d4f1c6d5` exited **1**, reporting `CONFLICT (content): Merge conflict in .github/workflows/opening-night-broadcast.yml`. This probe wrote only temporary mirror objects; no checkout file was changed. Completing the item requires resolving that conflict, testing the workflow without sending a broadcast, then landing under a card-bearing ref such as `land/bro-4813-broadcast-draft`. This run cannot do that because its instructions prohibit edits to `.github/workflows/**`, commits, pushes and landing. The existing ref was left intact.

## Already absent

`land/tour-phase-e` is absent from both live `git ls-remote --heads origin 'land/*'` listings. The Phase E sweep and roundup work also appears among the seven equivalent patches on `land/tour-roundup-suggest`.

## Mandatory checklist

- **a. Real before/after:** required the actual `landRefCardNumber()` from `scripts/lib/cloud-worker-pick.js:487` against all 28 live card-listed refs before and after. Both runs returned null for all 28; **0 records changed**. Examples: `land/font-selfhost`, `land/stale-excerpt-rescore`, `land/audience-london-broadwaycom` each remained null. No runtime code or core data was edited. The report classifies refs without altering routing.
- **b. Writer/caller:** branch-name producer instructions are `.claude/CLOUD.md:39`; `scripts/land-retry-cancelled.js:165-178` calls the real parser and logs refs that name no card. `.github/workflows/land-retry-cancelled.yml:116` calls the stranded pass. No downstream parser change or guessed card mapping was made.
- **c. Main:** the naming rule is already fixed by `49f286f321a`; the acceptance command passed before and after. All 29 explicit names were checked separately; a passing acceptance test did not conceal the unlanded broadcast change.
- **d. Wired in:** no new script, flag, function or test was added. The sole addition is this requested triage Outcome. Existing caller evidence is listed above.
- **e. Cost:** 0 new paid fetches, LLM calls or API calls per production run, and no new cron behavior. Audit used read-only Git remote requests; no paid provider, Linear, email or broadcast operation was invoked.

## Verification

All automated batches ran against the unchanged checkout at the exact origin/main SHA above before this documentation addition. Thus their failures are baseline failures, not introduced by this report. No TypeScript, scoring logic or content-quality patterns were edited, so their conditional checks do not apply.

| Command | Result |
| --- | --- |
| `node --test scripts/lib/land-stranded-refs.test.mjs` | PASS before and after: 19 tests each. |
| `node scripts/lib/unit-test-collection.js` | Collected 1,447 files; selected the 8 nearby files below rather than the full slow batch. |
| Nearby collector batch (exact command below) | PASS: 105 passed, 1 skipped, 0 failed. |
| `node --test --test-timeout 300000 scripts/lib/*.test.mjs` | Baseline FAIL: 12,182 passed, 17 failed, 17 skipped; 376 seconds. |
| `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet` | Harness exit 0; gate exit 1 only for missing actionlint (exit 127, explicitly ignored by job instructions). Read all 916 log lines: 68 labelled checks, no other failed gate. Top-level script coverage audit reports no gaps. |
| `node --test --test-reporter=tap tests/unit/rescore-flagging.test.mjs scripts/lib/nyt-pick-refresh-needed.test.mjs scripts/refresh-nyt-critics-picks.test.mjs tests/unit/font-integrity.test.mjs scripts/tests/verify-edits-cloud-session-gates.test.mjs` | PASS: 247 tests, confirming superseded behavior on main. |
| `git merge-tree --write-tree <main> d31c636c324a5dab77718e725bc893d1d4f1c6d5` | FAIL as expected: broadcast workflow content conflict; retain this ref. |

The exact command for the eight collected files was:

```bash
node --test --test-reporter=tap --test-timeout 300000 \
scripts/tests/ack-landed-already-landed.test.mjs \
scripts/tests/ack-landed-correlation-id.test.mjs \
scripts/tests/ack-landed-derive-sha.test.mjs \
scripts/tests/ack-landed-job-id.test.mjs \
scripts/tests/ack-landed-landed-elsewhere.test.mjs \
scripts/tests/ack-landed-naming-candidates.test.mjs \
scripts/tests/ack-landed-stranded-rebased.test.mjs \
tests/unit/land-preflight.test.mjs
```

Baseline library failure groups: cloud-core-data-copies (2, timeout/cleanup), critic-spelling-duplicates (1, corpus backlog), found-outlet-ids (3, review-text fixture writes unavailable), international-trade-cross-market (1, review-text fixture write), llm-ensemble-trigger-gate (3, review-text fixture writes), outlet-domain-guard-cousins (6, review-text fixture writes), outlet-domain-validation (1 leaf assertion, corpus backlog). No test or production implementation was changed to hide these failures.

REMAINING: Delete the 27 safe refs from a Mac session after verifying their tips.

REMAINING: Resolve and review the unlanded broadcast-draft workflow, test it safely, and land under a bro-N ref; workflow edits and landing are prohibited in this run.
