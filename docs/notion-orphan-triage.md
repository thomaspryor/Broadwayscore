# Retired Notion backlog triage (BRO-5297)

Snapshot: 2026-10-14. Checkout and origin/main: `4040e4b8a1b9696ac2fe4a8a01e2dd6b06db5e23`.

**Partial triage, not ready to close.** The acceptance file now exists, but 114 rows remain pending. This unattended worker is prohibited from touching Linear, so it cannot perform fresh twin searches or import still-real work. No Notion pages, Linear issues, GitHub issues or private review texts were changed.

## Source and completeness

Read the schema and all matching rows through the connected Notion MCP data source:

`collection://fa7b3ff2-c073-4097-b54c-0a78e56e06b6`

The exact read-only query was:

```sql
SELECT url, createdTime, "Name", "Status", "Priority", "Notes"
FROM "collection://fa7b3ff2-c073-4097-b54c-0a78e56e06b6"
WHERE datetime(createdTime) > datetime('2026-08-20')
  AND "Status" != 'Done'
ORDER BY createdTime, url
```

The connector caps SQL responses at 100 rows. The first response had `has_more: true`; explicit `LIMIT 100 OFFSET 100` and `LIMIT 100 OFFSET 200` retrieved the other 100 and 13 rows. An independent grouped count returned 189 Not started, 12 In progress, 12 Paused, and 99 Done. Thus the open inventory contains 213 unique pages, including 149 engineering/analytics rows and 64 feedback rows. The createdTime comparison includes August 20 after midnight, matching the card's stated filter.

The complete per-page inventory is [data/audit/notion-orphan-triage.json](../data/audit/notion-orphan-triage.json). It contains IDs, display titles, status, priority, creation time, disposition, and evidence. Notes were inspected in memory but not exported. Feedback titles are replaced by their type; feedback bodies, contact details, review text and credentials are omitted. Source title em dashes are rendered as colons; identity matching uses page IDs, not titles.

The four final verdicts from the card are retained. `pending` is an explicit additional interim verdict for work this worker cannot conclude. It must not be interpreted as obsolete or processed. There are zero `imported` rows.

## Dispositions

| Group | Count | Evidence |
|---|---:|---|
| Existing twin, historical import ledger | 32 | Exact Notion page-ID match in `data/linear-import-mapping.jsonl`, with BRO identifier and import timestamp |
| Existing twin, accepted newer card comment | 6 | BRO-47, BRO-67, BRO-2238, BRO-132, BRO-5327, BRO-5329, from the 2026-10-14 04:05 comment |
| Obsolete or fixed | 13 | Per-row code evidence or the newer comment's accepted result |
| Feedback processed | 48 | Linked GitHub issue closed; state reason, closure time and labels inspected |
| Engineering/analytics pending | 98 | No fresh Linear search; do not import until duplicate and current-premise checks finish |
| Review submission still open | 7 | Keep in existing GitHub processing path |
| Feedback without an issue link | 9 | Owner follow-up required; not assumed processed |
| **Total** | **213** | **38 twin, 13 obsolete, 48 feedback-processed, 114 pending** |

The checked-in ledger materially corrects the description's blanket orphan assumption. For example, the push-deadline card `3c2637c5-416f-8156-a330-c0e391f27545` already maps to BRO-2370; the outlet near-duplicate card `3c2637c5-416f-81d9-9bfc-cf8228b70728` maps to BRO-2371; the opening-night Express card `3c8637c5-416f-812a-a8e6-f529ab7831d2` maps to BRO-2402. These are historical import evidence only. Their present Linear state was not queried.

## The 48 frozen stuck-work rows are already accounted for

Carry forward the newer BRO-5297 04:05 comment's triage on main `fb11d216`; do not redo or re-import these rows. Their titles are preserved in [the retirement snapshot](notion-linear-residue-sweep.md#stuck-work-snapshot-at-retirement-2026-10-14). That snapshot also includes pages created before the freeze, so its count must not be added to the 213-row post-freeze inventory.

| Accepted disposition | Count | Details |
|---|---:|---|
| Existing Linear card by ID | 12 | BRO-406, BRO-318, BRO-51, BRO-115, BRO-67, BRO-2238, BRO-132, BRO-47, BRO-86, BRO-104, BRO-80 closed; BRO-70 still open as its own card |
| Fixed in code | 20 | Scraper environment top-up; protected manual-clear fields; digest push isolation; update-status timeout; VERIFY candidates; syndication survivor; scoring-delta inline-loop detector; CV self-heal; ingest collision/roundup guards (the comment qualifies these as probable); IBDB SERP checks; gap-audit fallback safety; blobless poller checkout; duplicate Sound of Music removal; unscored sweep; broadcast-state sync; rate-limit retry; form junk guards; legitimate redirects; main-red row; watchlist delete by design |
| Retired systems | 10 | Five cmux fleet items, crown v11 handoff, two opening-night launcher/environment items, the historical opening-night monitor, and reconcile-dead-completions sync-map |
| Still real and already filed | 4 | BRO-5327 P1 tour-contamination, BRO-5328 domain substring matching, BRO-5329 manual duplicate repair, BRO-5330 prior-run venue hint (measure first) |
| Still real, deliberately deferred | 2 | Whole-file time-bomb exemptions and priorRuns coverage in cv-wrongproduction-unhandled; dev-only, no visitor impact |

The 48-row carry-forward is accepted historical evidence, not a claim that this worker freshly read their Linear states. The relevant post-freeze pages are linked individually in the JSON. The dev-only items remain deferred; they are not classified as fixed.

## Feedback follow-up

Read all 55 issue links in Notes through the GitHub connector. Forty-eight are closed, including approved, rejected and invalid submissions. Closing a submission proves terminal processing, not publication. Examples: #890 and #961 are closed/completed with approved labels; #1023 is closed/completed with an invalid label.

These seven linked issues are still open:

| Notion ID | GitHub issue |
|---|---|
| `3e3637c5-416f-816a-a9c9-cb44cbc03f13` | [#907](https://github.com/thomaspryor/Broadwayscore/issues/907) |
| `3e4637c5-416f-8172-8ecb-feb908d8170a` | [#921](https://github.com/thomaspryor/Broadwayscore/issues/921) |
| `3e6637c5-416f-81d2-ad30-e63ad47cac4e` | [#935](https://github.com/thomaspryor/Broadwayscore/issues/935) |
| `3e6637c5-416f-8198-b082-cc85814fe9e3` | [#937](https://github.com/thomaspryor/Broadwayscore/issues/937) |
| `3e6637c5-416f-81c8-8ae3-ffd6b49eb0f9` | [#939](https://github.com/thomaspryor/Broadwayscore/issues/939) |
| `3f1637c5-416f-81f0-94c4-ec77147bb9b5` | [#1001](https://github.com/thomaspryor/Broadwayscore/issues/1001) |
| `3f5637c5-416f-8168-8a3d-e18302c96d34` | [#1019](https://github.com/thomaspryor/Broadwayscore/issues/1019) |

These nine feedback rows have no GitHub issue URL in Notes:

| Notion ID | Feedback type | Created |
|---|---|---|
| `3d1637c5-416f-8153-a865-c950e41e4e20` | [Other] | 2026-09-04 22:47:26Z |
| `3d5637c5-416f-811f-9946-fb80ef7463d0` | [Content Error] | 2026-09-08 12:26:06Z |
| `3e2637c5-416f-815e-be63-e80b357b121a` | [Other] | 2026-09-21 12:48:23Z |
| `3e2637c5-416f-814f-9d9b-f4af608e6d90` | [Content Error] | 2026-09-21 21:28:44Z |
| `3e4637c5-416f-817b-8905-e200b48515b5` | [Content Error] | 2026-09-23 12:33:37Z |
| `3ec637c5-416f-8176-b981-c3d181af82de` | [Other] | 2026-10-01 21:35:44Z |
| `3f2637c5-416f-8106-9138-cd9c7c5e0aea` | [Content Error] | 2026-10-07 09:50:52Z |
| `3f2637c5-416f-8174-badb-dd2fd541582b` | [Content Error] | 2026-10-07 09:52:31Z |
| `3f4637c5-416f-8156-86d8-cc016a073515` | [Content Error] | 2026-10-09 12:58:53Z |

Check the existing Formspree inbox and GitHub feedback pipeline for those nine. Lack of a link is not proof that a submission was dropped. Do not import user feedback into the engineering backlog merely to remove an orphan count.

## Concrete pending engineering findings

- `3c2637c5-416f-8112-b500-ea1b528e3274`: **P1: londontheatre.co.uk reviews silently lost : missing article-extractor PATTERNS entry**. Abigail's Party now has a london-theatre review by Julia Rank in real reviews.json. One recovered example does not prove all extraction failures fixed. Need Linear twin search and extraction/backfill verification; no live scrape performed.
- `3c2637c5-416f-81b6-a514-d92cc1efbced`: **Typo/edit-distance near-duplicate outlet detector (3rd slice after #1838/#1844)**. No page-id import-ledger match. Card's seven-title sample had no twin on 2026-10-13; current Linear search and code audit still required before importing.
- `3c2637c5-416f-81c4-905e-c79515fafede`: **Per-workflow REVIEW_TEXTS_TOKEN API-budget telemetry**. No page-id import-ledger match. Card's seven-title sample had no twin on 2026-10-13; current Linear search and telemetry audit required.
- `3c2637c5-416f-8185-a51a-e262becfcca6`: **Backfill 207 phantom theater-life Barry Gordin bylines + collapse 8 live double-counted reviews**. Old 207-file backlog mostly gone: 1 theater-life--barry-gordin.json remains and is suppressed under gypsy-2024. reviews.json still has 1 live Barry Gordin attribution under company-2006 in theater-life--eric-march.json. Need byline verification and any residual private-repo repair; no review texts changed.
- `3c8637c5-416f-81ee-8d3b-c8eefbcba15d`: **Consolidate 4 duplicate CI-detection (GITHUB_ACTIONS||CI) implementations**. CI checks remain inline at health-check.js:5690, rediscover-review-urls.js:53 and e2e-canary-alert-chain.js:35; owner-alert-router.js:119 exports the broad helper. Current Linear twin search required before filing cleanup.
- `3c8637c5-416f-814b-b947-e65b03f7ee49`: **bsc-next.js parseArgs silently no-ops on --flag=value equals-syntax (any flag, not just --id)**. Reproduced against real exported parseArgs: --id=12 yields {'_':[],'id=12':true}; --pick=3 has same bug; --id 12 works. Mac CLI scope; current Linear twin search and prioritization required, no bsc-next code changed.
- `3c8637c5-416f-814e-92db-efe7daf63615`: **audit-time-bomb-tests.js exemptions are whole-file, not per-test : could mask a future real bomb**. Still real but deliberately not filed in the BRO-5297 04:05 comment: whole-file time-bomb exemptions, dev-only with no visitor impact. Preserve as deferred work rather than calling it obsolete.

Three additional cleanup/hardening requests remain pending after reading their full Notes: the retry card asks for consolidation of five inline node wrappers, beyond the shared decision helper that already existed; the venue card concerns neighbourhood text glued to a real venue, which still passes the exact-match guard; the surge-helper refactor still leaves inline guards in clear-stale-wrong-production-flags.js:271 and :350. The existence of a helper alone does not establish that every requested caller has been migrated.

In particular, the seven-title sample in the card is not a current clean-import list. Tour-contamination already has BRO-5327 from the newer comment. All other candidates still need a fresh twin search before filing, even when the current code reproduces their premise.

For the byline backfill, real data showed 1 remaining `theater-life--barry-gordin.json` filename, suppressed under gypsy-2024, rather than the historical 207. The live reviews set has 1 Barry Gordin attribution under company-2006, whose stored filename is `theater-life--eric-march.json`. A Doll's House now has David Sheward and Samuel L. Leiter records; Gypsy publishes David Sheward. Filename cleanup alone cannot prove attribution correctness. Verify the company-2006 byline before concluding the private-repo backfill is complete.

For London Theatre, Abigail's Party now publishes a london-theatre review by Julia Rank. Recovery of that example does not establish that every extraction or backfill item is complete.

## Writer, caller and cost checks

The original site-side secondary Notion writes are already retired: `src/app/api/feedback/route.ts:8` describes Formspree as the processing path, and `src/app/api/submit-review/route.ts:105` writes GitHub issues. `scripts/posthog-friction-analyzer.js:13` documents the move to Linear. Existing guards are `scripts/tests/notion-live-write-paths.test.mjs` and `scripts/lib/notion-write-guard.js`. No downstream reader or production writer was patched.

This is a one-time document and audit inventory. No script, function, flag, workflow or cron was added. Paid fetches: 0. LLM calls: 0. External reads: 7 Notion MCP calls and 55 successful GitHub connector issue reads, plus 1 unauthenticated GitHub HTTP request that returned 403. A failed gh CLI authentication check made no request. No Linear calls or mutations were made.

## Verification and limits

Before changes, `test -f docs/notion-orphan-triage.md` exited 1. `git log -S 'notion-orphan-triage' --oneline -5 -- docs` returned no matches, and `git cat-file -e origin/main:docs/notion-orphan-triage.md` failed because the path was absent. HEAD and origin/main were identical.

The `/docs/*` ignore rule would also hide this new document from the runner's commit. A specific exception in `.gitignore` makes the acceptance artifact visible to Git, matching the existing residue-sweep exception.

Real-data comparison: previously no triage inventory, now 213 enumerated rows. Zero show/review records or external board records changed. Re-reading the open-row count returned 213. The JSON records all pending work explicitly rather than presenting a passing existence check as full completion.

| Command | Result |
|---|---|
| `test -f docs/notion-orphan-triage.md` | Pass after the document was added |
| Artifact identity/count/privacy check against the 213 fetched rows | Pass: 213 unique IDs, all rows accounted for, no Notes or raw feedback titles |
| `node --test --test-reporter=tap --test-timeout 300000 $(node scripts/lib/unit-test-collection.js \| rg 'notion\|feedback\|submit-review\|posthog\|linear-import')` | Pass: 384 passed, 20 skipped, 0 failed |
| `node --test --test-timeout 300000 tests/unit/load-env.test.mjs tests/unit/protected-fields-sync.test.mjs tests/unit/checkout-rate-limit-retry.test.mjs scripts/tests/notion-live-write-paths.test.mjs` | Pass: 31 passed |
| `node --test --test-timeout 300000 tests/unit/placeholder-venue.test.mjs` | Pass: 6 passed; the wrong-show sweep was inspected without LLM calls |
| `node --test --test-timeout 300000 scripts/lib/*.test.mjs` | Baseline failure: 12,223 passed, 16 failed, 17 skipped |
| `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet` then read `/tmp/gauntlet/lint-workflows.log` | All repository audits green; actionlint unavailable, exit 127 (ignored as instructed) |

The scripts/lib batch ran before these artifacts were written, on the exact origin/main checkout, with no tracked changes. Its 16 failures therefore predate this change: 13 review-text fixture creation failures (ENOENT against the protected private-data path), 2 live-corpus drift assertions, and 1 ENOTEMPTY fixture-cleanup failure. The report counts leaf test failures; TAP also prints a failed parent suite. No source or test files were changed. No TypeScript, scoring logic, content-quality patterns or UI changes were made, so their change-specific checks do not apply.

The gh CLI has no authentication in this runner and an unauthenticated HTTP probe returned 403. The connected GitHub tool supplied the issue-state evidence successfully, so feedback triage was not blocked by that fallback failure.

## Remaining work

- Perform fresh Linear twin searches for the 98 pending engineering/analytics rows. Inspect their current code/data premises, then import only still-real unmatched work via linear-brain.js create, P2 unless evidence warrants higher priority. Do not repeat the 32 ledger imports or the accepted 48-row triage.
- Continue processing the seven open GitHub review submissions through their existing path.
- Reconcile the nine unlinked feedback rows with Formspree/GitHub before assigning a terminal verdict.
- Verify the remaining company-2006 Barry Gordin attribution and any London Theatre extraction/backfill gaps. Any necessary private review-text writes belong to a worker authorized to write that repo.
- Preserve the two dev-only deferred items from the accepted 48-row triage.
- The runner must land these artifacts before the acceptance file exists on main. The file-existence check alone is insufficient to close BRO-5297 while pending rows remain.
