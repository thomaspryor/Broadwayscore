# BRO-8065 state (headless job, 2026-11-22 16:31 EST)

## Done
- Code: classifier rules, bot-wall unwrap, drain verdict histogram, shard fix, review fixes. Committed on job/linear-BRO-8065-mws9qg5d with a ship-check receipt.
- Tests: `node --test tests/unit/pending-triage.test.mjs` passes 93/93.
- 2025-26: dry run 98% settled/junk/duplicate; fetch promoted 0. Pushed to broadway-review-texts.
- 2015-24: 170 promoted (37 + 25 + 61 + 47), 824 tagged junk. Pushed to broadway-review-texts main (e7c46487779, 2cf2670e645). Every shard hit its 30-minute budget, so a remainder is left.
- Spend since 2026-11-22T20:38:26Z: 887 paid calls, about $1.02.

## Land status: NOT landed (attempt 3, run 45072537576, refused at gate lint-workflows; this branch changes no workflow file, so check whether main is red on actionlint, then rerun the land script)
- Land attempt 3: log /tmp/bro8065-land3.log. Attempt 2 was refused by the venue-write audit (a false positive, fixed with a venue-write-guard-ok comment).

## Remaining
1. If land 3 is refused, read its log, fix, and rerun `bash scripts/merge-worktree-to-main.sh`.
2. On up-to-date main: `node --test tests/unit/pending-triage.test.mjs`.
3. Finish the 2015-24 remainder. Use the data worktree /private/tmp/brt-8065 (pull first), with `REVIEW_TEXTS_DIR=/private/tmp/brt-8065`, and run this for i in 1..4: `node --env-file=.env scripts/replay-pending-bylines.js --all-pending --era=2015-24 --shard=$i/4 --time-budget-min=30`.
4. Pre-2015: triage first (`--triage-only`), then a sharded fetch.
