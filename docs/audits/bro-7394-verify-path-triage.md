# BRO-7394: VERIFY path triage

Checked 2026-11-13 against local `origin/main` at `cee5f155da71c60e044d3088333f430413cde2b6` (also the starting HEAD).
Source: `data/audit/card-verifiability-linear.json`, generated `2026-11-12T14:01:02.368Z`. It contains 84 entries; the card quoted 85 from an older report.

No Linear reads or writes were made. This inventory uses committed audit paths and the local Git tree. The available description snapshot is from 2026-08-26 and covers only 8 of these 84 cards, so current descriptions and correction comments must be read before deciding whether most absent files are intentional new artifacts. Titles and missing paths alone cannot settle that question.

Three entries now have every reported missing path on main. Eight have plausible existing replacements below. Of the other 73, BRO-118 has a historical description explicitly calling its path a new test file; the other 72 need current card descriptions to distinguish new work from typos. These are triage candidates, not applied repairs or proof of current card status.

The creation advisory now checks missing paths using the audit classifier and the local origin/main ref without fetching. Intended new artifacts can be declared in card notes:

```text
CREATES: scripts/lib/new-behavior.test.mjs, docs/new-runbook.md
VERIFY: node --test scripts/lib/new-behavior.test.mjs
```

The advisory warns and still permits filing for session and workflow callers. Unknown Git results also permit filing. No paid fetches, LLM calls, API calls or new cron jobs are added.

Replaying all 84 audit commands through the existing creation warning produced 0 warnings. The new advisory produces 81 warnings for still-absent paths and 0 for the 3 now-present entries. Declaring the reported absent paths with CREATES produces 0 warnings. This replay supplies command-only notes because current descriptions are unavailable here; 81 is the number requiring declaration or correction, not a claim that 81 cards contain typos. No source records were mutated.

## Existing replacement candidates

Preserve any other operands in the original command. Confirm each replacement tests the card's actual behavior before changing Linear. Path existence alone does not prove acceptance coverage.

| Card | Reported missing path | Existing candidate |
| --- | --- | --- |
| BRO-6412 | `scripts/social-autopost/social-autopost.test.mjs` | `scripts/social-autopost.test.mjs` |
| BRO-6356 | `scripts/lib/we-historical-tr-coverage.test.js` | `scripts/lib/we-historical-tr-coverage.test.mjs` |
| BRO-6097 | `scripts/lib/we-historical-tr-coverage.test.js` | `scripts/lib/we-historical-tr-coverage.test.mjs` |
| BRO-5893 | `docs/sprint-plan-adsense.md` | `sprint-plan-adsense.md` |
| BRO-5075 | `scripts/audit-relative-review-urls.test.mjs` | `scripts/lib/audit-relative-review-urls.test.mjs` |
| BRO-5045 | `scripts/validate-data.test.mjs` | `scripts/lib/validate-data.test.mjs` |
| BRO-4987 | `scripts/lib/grosses-history-repair.test.mjs` | `tests/unit/grosses-history-repair.test.mjs` |
| BRO-4245 | `scripts/reddit-api.test.mjs` | `scripts/lib/reddit-api.test.mjs` |

BRO-5893 needs special handling: `sprint-plan-adsense.md` exists at the repository root, but `test -f sprint-plan-adsense.md` is outside the allowed safe-form directories. A path-only substitution would leave that card unusable. Choose an acceptance check appropriate to the actual deliverable.

The historical BRO-7327 example is no longer in this 84-card report. Its real harness `scripts/test-url-wipe-hold.js` exists, but `node scripts/test-url-wipe-hold.js` is not an allowed VERIFY form. The new advisory catches the phantom `scripts/lib/url-wipe-hold.test.mjs`; repairing that old card still requires choosing an appropriate safe check.

## Complete inventory

| Card | Reported missing path | Local finding |
| --- | --- | --- |
| BRO-7342 | `tests/unit/provider-deprecations.test.mjs` | Absent; needs current description and comments |
| BRO-7341 | `tests/unit/scoring-openai-pin-live.test.mjs` | Absent; needs current description and comments |
| BRO-7330 | `scripts/stop-block-tally-audit.test.mjs` | Absent; needs current description and comments |
| BRO-7328 | `docs/designs/predict-critic-score-signed-in.md` | Absent; needs current description and comments |
| BRO-7314 | `scripts/predict-critic-score.test.mjs` | Now present on main; no path repair needed |
| BRO-7302 | `tests/unit/validate-data-ibdb-blocking.test.mjs` | Absent; needs current description and comments |
| BRO-7281 | `tests/unit/opening-night-dispatch-hardening.test.mjs` | Now present on main; no path repair needed |
| BRO-7267 | `tests/unit/gold-button-label-contrast.test.mjs` | Absent; needs current description and comments |
| BRO-7254 | `scripts/closing-watch-breakeven.test.mjs` | Absent; needs current description and comments |
| BRO-7240 | `tests/unit/critics-button-scroll.test.mjs` | Absent; needs current description and comments |
| BRO-7200 | `docs/PORTING.md` | Absent; needs current description and comments |
| BRO-7190 | `scripts/lib/advisory-durability.test.mjs` | Absent; needs current description and comments |
| BRO-7152 | `scripts/opening-night-watch.test.mjs` | Absent; needs current description and comments |
| BRO-7151 | `scripts/verify-annual-task-docs.test.mjs` | Absent; needs current description and comments |
| BRO-7140 | `tests/unit/rating-beside-date.test.mjs` | Now present on main; no path repair needed |
| BRO-7060 | `tests/unit/url-content-mismatch.test.mjs` | Absent; needs current description and comments |
| BRO-6949 | `tests/unit/session.test.mjs` | Absent; needs current description and comments |
| BRO-6917 | `tests/unit/web-signup-onboarding.test.mjs` | Absent; needs current description and comments |
| BRO-6915 | `memory/critic-outreach-approved.txt` | Absent; needs current description and comments |
| BRO-6844 | `scripts/homepage-promo-tracking.test.mjs` | Absent; needs current description and comments |
| BRO-6843 | `tests/unit/my-shows-button-interaction.test.mjs` | Absent; needs current description and comments |
| BRO-6807 | `memory/next-city-hub-decision.md` | Absent; needs current description and comments |
| BRO-6667 | `tests/unit/lane-rehearsal-recorded.test.mjs` | Absent; needs current description and comments |
| BRO-6449 | `scripts/test-versus-duo-verdict-top5-script.test.mjs` | Absent; needs current description and comments |
| BRO-6414 | `scripts/social-autopost-tony.test.mjs` | Absent; needs current description and comments |
| BRO-6412 | `scripts/social-autopost/social-autopost.test.mjs` | Existing replacement candidate above; confirm current card |
| BRO-6399 | `scripts/social-autopost/west-end-channels.test.mjs` | Absent; needs current description and comments |
| BRO-6374 | `memory/west-end-broadway-links.json` | Absent; needs current description and comments |
| BRO-6356 | `scripts/lib/we-historical-tr-coverage.test.js` | Existing replacement candidate above; confirm current card |
| BRO-6346 | `scripts/search-index-quality.test.mjs` | Absent; needs current description and comments |
| BRO-6309 | `scripts/send-money-welcome.test.mjs` | Absent; needs current description and comments |
| BRO-6295 | `scripts/port-tech-scorecard.test.mjs` | Absent; needs current description and comments |
| BRO-6250 | `scripts/video-plan-review.mjs` | Absent; needs current description and comments |
| BRO-6219 | `memory/push-alerts.md` | Absent; needs current description and comments |
| BRO-6213 | `memory/design-proposals.md` | Absent; needs current description and comments |
| BRO-6176 | `tests/unit/inspiration-ideas-variants.test.mjs` | Absent; needs current description and comments |
| BRO-6142 | `scripts/post-recovery-checklist.mjs` | Absent; needs current description and comments |
| BRO-6097 | `scripts/lib/we-historical-tr-coverage.test.js` | Existing replacement candidate above; confirm current card |
| BRO-5996 | `tests/unit/manufacturer-images.test.mjs` | Absent; needs current description and comments |
| BRO-5898 | `scripts/verify-backlog-cleared.test.mjs` | Absent; needs current description and comments |
| BRO-5893 | `docs/sprint-plan-adsense.md` | Existing replacement candidate above; confirm current card |
| BRO-5864 | `scripts/lib/models.test.mjs` | Absent; needs current description and comments |
| BRO-5847 | `scripts/owner-loose-ends-rescue.test.mjs` | Absent; needs current description and comments |
| BRO-5840 | `memory/seo-domain-authority-guide.md` | Absent; needs current description and comments |
| BRO-5813 | `tests/e2e/ios_maestro_coverage.test.mjs` | Absent; needs current description and comments |
| BRO-5673 | `scripts/verify-bro-5384-codex-throughput.test.mjs` | Absent; needs current description and comments |
| BRO-5572 | `tests/unit/unknown-critic-backlog.test.mjs` | Absent; needs current description and comments |
| BRO-5531 | `tests/unit/london-venues-park-theatre.test.mjs` | Absent; needs current description and comments |
| BRO-5485 | `scripts/verify-bro-5384-codex-throughput.test.mjs` | Absent; needs current description and comments |
| BRO-5405 | `scripts/lib/seo-health-staleness.test.mjs` | Absent; needs current description and comments |
| BRO-5404 | `tests/unit/apple-relay-sender-registration.test.mjs` | Absent; needs current description and comments |
| BRO-5287 | `scripts/verify-codex-runner-health.test.mjs` | Absent; needs current description and comments |
| BRO-5284 | `scripts/lib/trade-search.test.mjs` | Absent; needs current description and comments |
| BRO-5283 | `scripts/check-cookie-health.test.mjs` | Absent; needs current description and comments |
| BRO-5259 | `scripts/check-byline-evidence.test.mjs` | Absent; needs current description and comments |
| BRO-5123 | `tests/unit/star-deals-sourced.test.mjs` | Absent; needs current description and comments |
| BRO-5075 | `scripts/audit-relative-review-urls.test.mjs` | Existing replacement candidate above; confirm current card |
| BRO-5045 | `scripts/validate-data.test.mjs` | Existing replacement candidate above; confirm current card |
| BRO-4987 | `scripts/lib/grosses-history-repair.test.mjs` | Existing replacement candidate above; confirm current card |
| BRO-4939 | `tests/unit/audit-tour-pages.test.mjs` | Absent; needs current description and comments |
| BRO-4799 | `scripts/codex/auth-store.test.mjs` | Absent; needs current description and comments |
| BRO-4766 | `tests/unit/star-rating-ref.test.mjs` | Absent; needs current description and comments |
| BRO-4745 | `tests/unit/codex-trial-acceptance.test.mjs` | Absent; needs current description and comments |
| BRO-4343 | `scripts/youtube-transcript-extraction.test.mjs` | Absent; needs current description and comments |
| BRO-4337 | `tests/unit/btc-season-config.test.mjs` | Absent; needs current description and comments |
| BRO-4318 | `scripts/verify-adjudication-corrections.test.mjs` | Absent; needs current description and comments |
| BRO-4245 | `scripts/reddit-api.test.mjs` | Existing replacement candidate above; confirm current card |
| BRO-4057 | `tests/unit/exit-status-gate.test.mjs` | Absent; needs current description and comments |
| BRO-4053 | `tests/unit/daily-mail-coverage-gap.test.mjs` | Absent; needs current description and comments |
| BRO-3569 | `tests/e2e/ios_maestro_coverage.test.mjs` | Absent; needs current description and comments |
| BRO-3541 | `tests/unit/check-corpus-drift-timeout-budget.test.mjs` | Absent; needs current description and comments |
| BRO-3467 | `scripts/tests/dispatch-watchdog-consecutive-blocks.test.mjs` | Absent; needs current description and comments |
| BRO-3217 | `scripts/lib/cmux-workspaces-parse-failures.test.mjs` | Absent; needs current description and comments |
| BRO-2762 | `tests/unit/sort-toggle.test.mjs` | Absent; needs current description and comments |
| BRO-2593 | `tests/unit/dmarc-reject.test.mjs` | Absent; needs current description and comments |
| BRO-2445 | `scripts/codex-timeout-fallback.test.mjs` | Absent; needs current description and comments |
| BRO-2422 | `scripts/lib/check-secrets-health.test.mjs` | Absent; needs current description and comments |
| BRO-2198 | `scripts/worktree-disk-usage.test.mjs` | Absent; needs current description and comments |
| BRO-2065 | `scripts/thestage-pages-on-stages.test.mjs` | Absent; needs current description and comments |
| BRO-825 | `src/components/CommercialScorecard.tsx` | Absent; needs current description and comments |
| BRO-771 | `tests/unit/stubhub-api-credentials.test.mjs` | Absent; needs current description and comments |
| BRO-118 | `scripts/lib/stats-screen-ui.test.mjs` | Historical description says new test file; reconfirm current card |
| BRO-81 | `scripts/design-sync-verify-project.sh` | Absent; needs current description and comments |
| BRO-7075 | `scripts/lib/morning-digest-attachment.test.mjs` | Absent; needs current description and comments |

## Validation

`node --test scripts/audit-card-verifiability.test.mjs` passed 25/25 before editing, with HEAD equal to origin/main. The audit test was left unchanged. `git log -S 'BRO-7394' --oneline -5 -- scripts/lib/linear-issue-create.js` returned no prior implementation in the available history. `git log -S 'missingCheckPaths' --oneline -5 -- scripts/audit-card-verifiability.js` returned the existing audit at `9855ce4ca`.

The new regressions were run before the implementation with:

```sh
node --test --test-timeout 300000 --test-name-pattern 'missingVerifyPathWarning|missing VERIFY paths|failed VERIFY path probe' scripts/lib/linear-issue-create.test.mjs
```

All five failed, including the creation integration assertion: expected two warnings, got zero. After the fix, `node --test --test-timeout 300000 scripts/lib/linear-issue-create.test.mjs scripts/audit-card-verifiability.test.mjs` passed 81/81. The exact acceptance command `node --test scripts/audit-card-verifiability.test.mjs` was also rerun after the change and passed 25/25. `node --test --test-timeout 300000 tests/unit/audit-log-gitignore.test.mjs` passed 11/11.

The dependent test selection and execution used this Node heredoc (855 tests passed across 20 dependent files):

```js
const {execFileSync}=require('node:child_process');
const files=execFileSync('rg',['-l','linear-issue-create','tests','scripts','--glob','*.test.*'],{encoding:'utf8'}).trim().split('\n').filter(p=>p!=='scripts/lib/linear-issue-create.test.mjs');
const out=execFileSync('node',['--test','--test-timeout','300000',...files],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:360000,maxBuffer:12*1024*1024});
console.log(out.split('\n').slice(-10).join('\n'));
```

Wiring: `scripts/linear-brain.js:861` calls the shared creator. `scripts/lib/linear-issue-create.js:396` calls the new helper before filing. The integration regressions exercise that same creator with a stub client for both session and workflow sources.

`GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet` completed with `lint-workflows: all gates green` and `lint-workflows=0`. Its log was inspected. Actionlint was unavailable locally and was skipped by the harness, as permitted by the worker instructions. `git diff --check` passed. No unrelated tracked files were rewritten; the temporary gauntlet directory was removed after inspection.

REMAINING: Read current descriptions and comments to complete the intended-artifact versus stale-path split, then repair the confirmed stale VERIFY lines in Linear. Linear access and edits were prohibited for this unattended run.
