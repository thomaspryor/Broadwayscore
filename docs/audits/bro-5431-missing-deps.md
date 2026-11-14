# BRO-5431 dependency audit, 2026-10-19

The original text-based require sweep reproduces **25 workflows, 29 distinct
workflow/script pairs, 32 job/script records** on this checkout. The card calls
these 25 pairs, but 25 is the workflow count. All 32 records are false positives
for an unhandled dependency failure during module initialization on current main.
No application or workflow dependency fix is indicated by the inspected source.

The AST audit scans 904 script invocations across 286 workflows and reports
**0 unmet eager dependency graphs and 0 inspection errors**. No core-data or
review records were changed. Source and workflow files are the real inputs here.
The acceptance test was absent on origin/main before this change.

Main already removed the original failing orchestrator tail:
`opening-night-orchestrator.yml:767-775` documents BRO-5427 and delegates the
checklist to its dependency-installed workflow. `git log -S 'audit-missing-deps'
--oneline -5 -- scripts .github/workflows/test.yml` returns no commits, and
`git cat-file -e origin/main:scripts/audit-missing-deps.test.mjs` exits 128 because
the path is absent. Searches for `sharp = null` and the lazy Playwright require
each resolve to snapshot commit `db95630e`; both guards are already on main.

## Classification and recent logs

Latest completed runs were listed with GitHub's read-only
`GET /repos/thomaspryor/Broadwayscore/actions/workflows/{file}/runs` endpoint.
Jobs and decoded job logs were read through `github_fetch_workflow_run_jobs`
and `github_fetch_workflow_job_logs`. All 23 available job logs below contained
zero matches for `Cannot find module` or `Cannot find package`. A successful
job is not proof that every conditional command executed. Skipped jobs and
workflows with no runs are explicitly marked; no workflows were dispatched.
Dates are UTC. Job links identify the exact logs inspected.

Classification keys, grounded in the actual dependency writers:

- **D**: `dotenv` occurs only in a comment in `scripts/lib/load-env.js:16`.
  This file parses environment files with builtins. There is no dotenv require.
- **L**: Playwright and axios occur inside deferred function bodies.
  For example, `scripts/lib/scraper.js:1180` loads Playwright only when the
  browser fallback is invoked. These are outside this audit's eager scope.
- **E**: `scripts/lib/blox-rot47-decode.js:15` catches a missing `entities`
  package and supplies a builtin fallback. This is the real transitive loader
  reached by `check-cookie-health.js` through `article-extractor.js`.
- **S**: `scripts/check-image-aspect.js:60` catches a missing `sharp` package
  and uses image headers instead. The daily digest imports this module.
- **P**: `opening-night-stage-alert.yml:70` mentions rebuilding in its issue
  body, not as a shell command. Its actual `check-opening-night-scored.js`
  invocation has no external package dependency.

Every row is a static false positive. All scripts below are in `scripts/`;
parenthesized names identify multiple jobs using the same script.

| Workflow | Suspect scripts / jobs | Class | Latest completed run and inspected job |
| --- | --- | --- | --- |
| audit-bww-rr-attributions.yml | audit-bww-rr-critic-mismatches.js | L, D | [39030885608 / 117390917788](https://github.com/thomaspryor/Broadwayscore/actions/runs/39030885608/job/117390917788), Oct 17; audit step exits 1, no missing module |
| audit-cross-production.yml | audit-cross-production.js | L, D | [39118300427 / 117648502275](https://github.com/thomaspryor/Broadwayscore/actions/runs/39118300427/job/117648502275), Oct 18; success |
| audit-dependencies.yml | audit-dependencies.js | D | [39124009511 / 117665238351](https://github.com/thomaspryor/Broadwayscore/actions/runs/39124009511/job/117665238351), Oct 18; success |
| check-arm-yield.yml | check-arm-yield.js | D | [39142863199 / 117720677207](https://github.com/thomaspryor/Broadwayscore/actions/runs/39142863199/job/117720677207), Oct 18; success |
| check-cookie-health.yml | check-cookie-health.js | E | [39158680775 / 117767153613](https://github.com/thomaspryor/Broadwayscore/actions/runs/39158680775/job/117767153613), Oct 18; success |
| check-linear-drain-health.yml | linear-drain-parked.js; check-linear-drain-health.js | D | [39153306738 / 117751243558](https://github.com/thomaspryor/Broadwayscore/actions/runs/39153306738/job/117751243558), Oct 18; success |
| check-morning-digest-sent.yml | check-morning-digest-sent.js | D | [39149622948 / 117740405339](https://github.com/thomaspryor/Broadwayscore/actions/runs/39149622948/job/117740405339), Oct 18; success |
| check-opening-night-readiness.yml | check-opening-night-readiness.js; route-readiness-failure.js | D | [39127918487 / 117676849697](https://github.com/thomaspryor/Broadwayscore/actions/runs/39127918487/job/117676849697), Oct 18; success |
| check-push-ledger.yml | check-push-ledger.js | D | [39220020394 / 117952882360](https://github.com/thomaspryor/Broadwayscore/actions/runs/39220020394/job/117952882360), Oct 19; success |
| check-secrets-health.yml | check-secrets-health.js | D | [38308617046 / 115008622433](https://github.com/thomaspryor/Broadwayscore/actions/runs/38308617046/job/115008622433), Oct 12; success |
| daily-digest.yml | send-daily-digest.js | S | [39214643896 / 117935557704](https://github.com/thomaspryor/Broadwayscore/actions/runs/39214643896/job/117935557704), Oct 19; success |
| extract-pull-quotes.yml | extract-pull-quotes.js | L, D | [39239003717 / 118015001861](https://github.com/thomaspryor/Broadwayscore/actions/runs/39239003717/job/118015001861), Oct 19; success |
| finance-ingest.yml | gmail-reauth.js (renew-gmail) | D | [39136513065](https://github.com/thomaspryor/Broadwayscore/actions/runs/39136513065), Oct 18; job skipped, no log. Also skipped in run 38849998828. Same script executes in gmail-reauth.yml below. |
| gmail-reauth.yml | gmail-reauth.js | D | [38849947459 / 116808732916](https://github.com/thomaspryor/Broadwayscore/actions/runs/38849947459/job/116808732916), Oct 16; success |
| land-retry-cancelled.yml | land-retry-cancelled.js (sweep, stranded); linear-reclaim-abandoned.js (reclaim) | D | [39253443545 / 118062675960](https://github.com/thomaspryor/Broadwayscore/actions/runs/39253443545/job/118062675960), Oct 19; sweep success, stranded/reclaim skipped. Same skips in run 39251099900. |
| linear-unpark-drain.yml | linear-unpark-drain.js | D | Workflow runs endpoint returned no runs, including an unfiltered history query. Static classification only. |
| mezzanine-token.yml | mezzanine-token.js | D | [39197486422 / 117883286234](https://github.com/thomaspryor/Broadwayscore/actions/runs/39197486422/job/117883286234), Oct 19; success |
| opening-night-stage-alert.yml | rebuild-all-reviews.js (issue prose only) | P | [39143848774 / 117723571649](https://github.com/thomaspryor/Broadwayscore/actions/runs/39143848774/job/117723571649), Oct 18; scored-stage coverage step exits 1, no missing module |
| sync-vercel-env.yml | lib/check-vercel-required-env.js; lib/probe-dispatch-link.js | D | [38310405537 / 115014455333](https://github.com/thomaspryor/Broadwayscore/actions/runs/38310405537/job/115014455333), Oct 12; success |
| test.yml | route-main-streak-signatures.js (test-summary) | D | [39253403781 / 118068841089](https://github.com/thomaspryor/Broadwayscore/actions/runs/39253403781/job/118068841089), Oct 19; Check results fails, no missing module |
| update-lbo.yml | scrape-lbo-audience.js | L, D | [39238644482 / 118013802210](https://github.com/thomaspryor/Broadwayscore/actions/runs/39238644482/job/118013802210), Oct 19; success |
| update-ltd.yml | scrape-ltd-audience.js | L, D | [39154341162 / 117754337533](https://github.com/thomaspryor/Broadwayscore/actions/runs/39154341162/job/117754337533), Oct 18; success |
| update-mezzanine.yml | mezzanine-token.js (scrape-mezzanine, resolve-unmatched-imports, refresh-mezzanine-catalog) | D | [39200568009 / 117892499757](https://github.com/thomaspryor/Broadwayscore/actions/runs/39200568009/job/117892499757), Oct 19; scrape success, other two jobs skipped. Same skips in run 39197528075. |
| update-seatplan.yml | scrape-seatplan-audience.js | L, D | [39238640553 / 118013790050](https://github.com/thomaspryor/Broadwayscore/actions/runs/39238640553/job/118013790050), Oct 19; success |
| update-show-status.yml | discover-playbill-urls.js (trigger-data-agent) | L, D | [39126308991 / 117676730991](https://github.com/thomaspryor/Broadwayscore/actions/runs/39126308991/job/117676730991), Oct 18; success |

## Guard and verification

`scripts/lib/missing-deps.js` owns the graph and shell-command analysis. It reads
files without importing or executing the audited scripts. It follows local
requires/imports, distinguishes eager, caught and lazy package loads, handles
cycles, and ignores builtins, comments, quoted prose and heredoc bodies.
Dependency installation must precede the script in the same job; raw
`actions/setup-node` and an npm cache do not count. Conditional installs must
cover the script condition. The shared setup-node action, `npm ci`, `npm install`
and the repo's `npm ci || npm install` idiom count as installations.

`scripts/audit-workflow-hygiene.js:810` calls the new library from its existing
CI/land entry point. Findings and inspection failures produce advisory warnings
and are excluded from its blocking total. `test.yml:3610` already calls this
entry point. This provides active CI coverage without editing any workflow.
The acceptance suite injects a real axios-requiring script into a workflow
without installation and verifies both the warning and successful CLI exit.

Reproduce the full scan without network, scraping or core-data writes:

```sh
node - <<'NODE'
const { auditDirectory } = require('./scripts/lib/missing-deps');
const result = auditDirectory('.github/workflows', process.cwd());
console.log(`${result.scripts.length} invocations, ${result.findings.length} findings, ${result.errors.length} inspection errors`);
NODE
node --test scripts/audit-missing-deps.test.mjs
node scripts/audit-workflow-hygiene.js
```

Observed: 904 invocations, 0 findings, 0 inspection errors; 14 acceptance tests
pass; hygiene passes across 286 workflows. The final related test set passed
345 tests in 28 files with this command:

```sh
node --test --test-timeout 300000 $(rg -l 'audit-workflow-hygiene|missing-deps' tests scripts --glob '*.test.*')
```

An in-memory regression fixture using the real opening-night-checklist.js graph
reports missing `cheerio` before installation and zero findings after inserting
the shared setup-node action. No workflow file was altered for that probe.

Scope limits: this is module-initialization analysis, not an interpreter. It does
not prove computed require paths, arbitrary function-call reachability, inline
`node -e` programs, scripts invoked through shell/npm wrappers, or whether a lazy
browser fallback will work. Parsing/resolution failures are warnings rather than
silently treated as a clean graph. Real inputs changed from 32 textual suspects
to zero eager findings; application/data behavior changed for zero records.

Added runtime cost: zero paid fetches, zero LLM calls, zero GitHub/API calls per
audit run. Only local source parsing is added to the existing CI and land audit.
The log reads above were one-time investigation calls, not new cron behavior.
The required `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh
/tmp/gauntlet` completed with exit 1 solely for `actionlint: command not found`
(exit 127). Every other lint-workflows audit passed; the worker instructions
explicitly permit ignoring that missing tool.

## Remaining acceptance work

The worker instructions prohibit all `.github/workflows/**` edits. Therefore the
exact requested separate failing step in `test.yml` with
`continue-on-error: true` was not added. The existing hygiene caller supplies an
equivalent advisory warning, but its process deliberately exits zero on these
findings. Adding that distinct failing-but-tolerated step requires an authorized
workflow-edit task.

Recent executed-job evidence remains unavailable for the explicitly skipped jobs
and the never-run linear-unpark-drain workflow. They have a static false-positive
classification, not a claim of runtime verification. Do not dispatch operational
workflows merely to fill that evidence gap.
