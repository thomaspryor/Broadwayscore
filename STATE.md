# BRO-6287 state (2026-10-26 13:20Z)
Done:
- Root cause for the 114 remaining wrong-production TR files: raw/default modes lose the page-top caption (pdftotext \f glued to prior line) and only a block's first review has a caption. Fixed in scripts/lib/tr-pdf-parse.js: splitPdfLines (\f = newline) + captionOwnedBy {inherit:true} (caption inheritance, stops at run/info lines, wrapped/near titles; never outranks positive section/venue match; memoized). Tests in tr-pdf-parse.test.mjs (39 pass; new tests fail without the fix). ship-check run (Claude panelist + Codex), P1s fixed, verdict recorded.
- Commit a129b49a72b pushed to origin/land/job/linear-BRO-6287-mvp6ligf. Checks job green (run 40326405265); the Land job was cancelled at "Admit to the landing queue" (busy queue), NOT landed on main.
Remaining:
1. Land: `bash scripts/merge-worktree-to-main.sh` (or git push origin HEAD:refs/heads/land/job/linear-BRO-6287-mvp6ligf to retrigger), confirm `git merge-base --is-ancestor a129b49a72b origin/main`.
2. After landing: `gh workflow run review-refresh.yml -f tr_show_filter="$(cat <46 show ids from the audit; list = shows with TR wrong_show files lacking trNoRecordForProduction)>"` (previous run 40316671335 used pre-fix parser: 114 remained).
3. Re-measure: node script counting source=theatre-record && isWrongShowRejection && !trNoRecordForProduction in ~/broadway-review-texts for west-end-2016..2021; need <40 (was 114). Also node scripts/validate-data.js --strict and node scripts/check-we-historical-tr-coverage.js (exit 0 currently).
4. Rescore/rebuild happens via the refresh workflow's requeue path.
