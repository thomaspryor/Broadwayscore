# BRO-6343 state (2026-10-26 ~23:57Z)

## Done
- Run-head parsing for TR volumes 35-36 (2015-16): headers 11 -> 32 of ~60 PDF matches. Landed on main.
- A-Z parser handles shifted (issue 159) and spread (163) pages. Landing via land.yml run 40421374290.
- Run-head venue lines "NATIONAL, OLIVIER", "ROYAL COURT, DOWNSTAIRS", "CENTRAL ST MARTINS, FOUND 111", "UNION SE1"
  now match (commits on this branch after 2f8ce3ed2a0; reviewed, verdict recorded). 47 tests pass.
- Promote dry run on main data: 8 new 2015-16 shows (Cleansed, Farinelli, Hobson's Choice, Husbands and Sons,
  Notmoses, Roosevelvis, The Deep Blue Sea, The Flick). 25 rows still "no dates on TR production page".

## Remaining (in order)
1. Land this branch: `bash scripts/merge-worktree-to-main.sh`
2. `gh workflow run we-historical-tr-resolve.yml -f seasons=2015-2016 -f resume=true` (wait, then git pull)
3. `node scripts/promote-historical-we.js --season=2015-2016 --verbose`, run
   `node scripts/validate-show-venue.js --show=<id>` on each new id, then `--plan=bro-6343-1516-tr`,
   `git add -f data/pending-fixes/bro-6343-1516-tr.json`, land, dispatch execute-approved-fix.yml
   (issue_number=bro-6343-1516-tr, plan_id from the file).
4. Gather/collect/score for the new ids: BRO-6396 owns the season's gather/score/SEASON PASS chain.
5. A-Z re-dump of all 2015-16 issues (159-179, 607, 608, 928-932) via we-historical-tr-ocr-probe.yml
   `@dump:/archive/issue/N:azraw:0`, then `node scripts/build-we-az-season.js --season=2015-2016 --lines=<dump>`.
   Issue 160 has a +29 char-shifted text layer (not parsed; 159/161 bracket it).
