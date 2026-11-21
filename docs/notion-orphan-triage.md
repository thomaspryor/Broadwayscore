# Retired Notion backlog triage (BRO-5297)

Snapshot: 2026-10-14. Checkout and origin/main: `4040e4b8a1b9696ac2fe4a8a01e2dd6b06db5e23`. Engineering pass: 2026-10-18 on `b96779bd1d224f7313bbfffc7a3990fc693f9270`.

**Engineering triage finished; 42 rows still pending, so not ready to close.** The 2026-10-18 pass resolved 72 of the 98 pending engineering/analytics rows against a fresh Linear dump and current main, and imported 20. Still pending: 26 engineering rows that are real but over the 20-import cap (one needs an owner call), plus the 7 open review submissions and 9 unlinked feedback rows, which stay for owner follow-up. No Notion pages, GitHub issues or private review texts were changed.

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

The four final verdicts from the card are retained. `pending` is an explicit additional interim verdict for work this worker cannot conclude. It must not be interpreted as obsolete or processed. There are now 20 `imported` rows, each with its BRO id.

## Dispositions

| Group | Count | Evidence |
|---|---:|---|
| Existing twin, historical import ledger | 32 | Exact Notion page-ID match in `data/linear-import-mapping.jsonl`, with BRO identifier and import timestamp |
| Existing twin, accepted newer card comment | 6 | BRO-47, BRO-67, BRO-2238, BRO-132, BRO-5327, BRO-5329, from the 2026-10-14 04:05 comment |
| Existing twin, 2026-10-18 Linear search | 18 | Fresh search of all Linear issues incl. closed/archived; BRO id in each row (2 point to BRO-5585, filed this pass) |
| Obsolete or fixed, first pass | 13 | Per-row code evidence or the newer comment's accepted result |
| Obsolete or fixed, 2026-10-18 | 34 | Per-row grep, data count, test or script run on current main, quoted in the row |
| Imported to Linear, 2026-10-18 | 20 | Parked P3 cards BRO-5571 to BRO-5590, see below |
| Feedback processed | 48 | Linked GitHub issue closed; state reason, closure time and labels inspected |
| Engineering real, over the import cap | 25 | Verified still real; listed below for the parent to file |
| Engineering real, owner call | 1 | Tom's blog reviews for shows not in shows.json |
| Review submission still open | 7 | Keep in existing GitHub processing path |
| Feedback without an issue link | 9 | Owner follow-up required; not assumed processed |
| **Total** | **213** | **56 twin, 47 obsolete, 20 imported, 48 feedback-processed, 42 pending** |

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

## Engineering/analytics resolution (2026-10-18)

Method: one GraphQL dump of all 5,567 Linear issues (open, closed and archived), searched by Notion page id, exact title and several distinctive keywords per row; then a grep, data count, test or script run on current main for rows with no twin. Each row's `reason` in the JSON quotes that evidence. Notable obsolete premises: the fetch-timeout audit now reports 27 gaps (card said 163), `validate-data.js` exits 0 with 0 garbage outlets, and 429 of 629 londontheatre.co.uk texts are complete (the 172 invalid are wrong-production flags, not extraction loss).

Imported (parked, P3, each with acceptance criteria; `linear-brain.js create` made a new issue every time, no reuse):

| BRO | Notion | Title |
|---|---|---|
| BRO-5571 | `3c8637c5-416f-8113-b5b5-e0dda903aac6` | Regional show breadcrumb links to Broadway browse pages |
| BRO-5572 | `3c5637c5-416f-81ac-9f88-d9c28a97a34d` | 650 reviews have Unknown/missing criticName across dozens of WE/OB shows : verify live-page by… |
| BRO-5573 | `3c2637c5-416f-8105-9b24-dc49bec3b2b8` | Off-Broadway aggregator promotion gate has the same roundup-exists weak-signal gap BRO-125 fix… |
| BRO-5574 | `3c2637c5-416f-81be-9ba7-cbc830e90bb4` | backfill-playwright-credits.yml missing shows-json-writer concurrency group |
| BRO-5575 | `3c8637c5-416f-8161-a152-ce0ed9b2606f` | P2: promote-ob-venue-candidates.js has no cap on PROMOTIONS per run (only staging caps candida… |
| BRO-5576 | `3c2637c5-416f-817f-a4c2-f27393c2aca7` | recover-serp-text.js existing-url --domain mode doesn't match registered domain aliases |
| BRO-5577 | `3c2637c5-416f-81b6-a514-d92cc1efbced` | Typo/edit-distance near-duplicate outlet detector (3rd slice after #1838/#1844) |
| BRO-5578 | `3c2637c5-416f-81f5-ac1c-ee0143ccfe08` | Feedback dedup still keys same-bug matching off a single showId (BRO-130 cousin) |
| BRO-5579 | `3c8637c5-416f-8110-a776-f5cba1657e16` | Move venue write-time validation into the shows.json write choke point (saveShows) |
| BRO-5580 | `3c8637c5-416f-81f9-9046-c2724c71b8da` | P2: isPlaceholderVenue is exact-match only, not contamination-safe |
| BRO-5581 | `3c5637c5-416f-81c6-b5cb-c2bfaa3e936a` | BRO: Show detail page hand-rolls its own score box instead of shared ScoreBadge component |
| BRO-5582 | `3c2637c5-416f-816b-b141-e142cfff8362` | Backfill wrongProductionNote for legacy flags with no audit trail (~12% of sample) |
| BRO-5583 | `3c2637c5-416f-817e-a4b7-e775c76df11d` | syncTrackerToOrigin: --recreate-draft clear path doesn't sync deletions to origin (mergeTracke… |
| BRO-5584 | `3c8637c5-416f-81e9-8ec8-c9f0e7294733` | Hardening: dispatch/succession/job-lease claim families share the release-by-key-only gap (no… |
| BRO-5585 | `3c6637c5-416f-81cf-8247-f8194e78b40f` | High search-to-user ratio suggests search is primary nav : no search UX improvements shipped |
| BRO-5586 | `3db637c5-416f-81e0-8d73-f8b52fa1d2cc` | Missing show: A Masked Ball |
| BRO-5587 | `3c8637c5-416f-8185-abf2-c44b2c160384` | Consolidate 16 ungated needsRescore=true call sites onto isStaleScoreInput()/markRescoreNeeded… |
| BRO-5588 | `3c2637c5-416f-81ef-b6ce-c2332e1c9e72` | Extend BRO-2238 failing-test-name observability to 2 more node --test batches in test.yml |
| BRO-5589 | `3c2637c5-416f-8124-a819-fcc5872f4224` | push-via-git-api.sh: teach the fallback protected-field reconciliation so review-texts can rej… |
| BRO-5590 | `3c8637c5-416f-814e-92db-efe7daf63615` | audit-time-bomb-tests.js exemptions are whole-file, not per-test : could mask a future real bo… |

Real but not imported (26 rows, verdict `pending`). All but one are "real, over the import cap"; the Edward/High Spirits row needs an owner decision on whether those productions belong in the catalog:

| Notion | Title |
|---|---|
| `3c2637c5-416f-81e6-a344-d6b5127143d7` | Audit scripts/lib for pure decision/gate modules with zero production callers |
| `3c2637c5-416f-81d3-ba72-e285920a0a5f` | Extract + test the missingReviews diff logic in bww-rr/dtli-count-mismatch checks |
| `3c2637c5-416f-81e3-b2f7-dd025e5be6e4` | Harden manual-review-direct.js: criticKey-based twin matching + _meta stamping |
| `3c2637c5-416f-8181-aa35-e846be5750fa` | Same-batch alias-collision skip is order-dependent (no tie-break) |
| `3c2637c5-416f-81c4-905e-c79515fafede` | Per-workflow REVIEW_TEXTS_TOKEN API-budget telemetry |
| `3c2637c5-416f-8140-ab13-ee3ad227cb13` | discover-historical-shows.js div-grid pseudo-table has zero column-schema guard |
| `3c2637c5-416f-81d1-b507-d3f01f402fde` | Generalize audit-test-yml-lib-deps.js to catch top-level scripts/*.js missing from test.yml pu… |
| `3c2637c5-416f-81f6-984c-fd70c5e4fc5d` | LLM fallback needs a per-show cooldown for persistently-partial aggregator pages |
| `3c2637c5-416f-8156-8886-c5f2f543e91a` | Extend BRO-67 LLM fallback pattern to non-DTLI/BWW aggregator extractors |
| `3c2637c5-416f-8103-8d29-d2e59f2a9dc0` | Extract shared rate-limit-retry-decision helper (5 near-duplicate inline node -e blocks) |
| `3c2637c5-416f-8162-8471-c6926a260c07` | health-check.js: surface per-workflow Git Data API fallback usage in the daily digest (not jus… |
| `3c2637c5-416f-8142-9a93-f5b41500819c` | Migrate remaining hand-rolled GitHub API helpers to gh-api-client.js |
| `3c5637c5-416f-8163-86f9-d7aefb87208a` | CI guard: detect workflow steps calling hang-prone external CLIs with no timeout bound |
| `3c5637c5-416f-8132-bc80-fc00cd3ee70d` | Add regression guard against raw new Date(data.publishDate) recurring in rebuild-all-reviews.js |
| `3c5637c5-416f-81f2-a462-c7d1018e03cc` | verify-edits.sh event parser doesn't filter subagent/sidechain tool calls : can mis-attribute… |
| `3c7637c5-416f-8183-8054-c07096eeaacb` | CI audit: flag continue-on-error steps with tight timeout-minutes wrapping unbounded per-item… |
| `3c8637c5-416f-8150-9da8-d613c17b88e8` | Self-heal pass for pull-quote-compilation isRoundupArticle detection on existing corpus |
| `3c8637c5-416f-8122-9908-d809025aed18` | memory-sync-pull.js reconcile merge has no autostash equivalent for unrelated dirty files |
| `3c8637c5-416f-81b8-9e96-e2be31b1e41e` | Extend component-level test coverage to SinglePasteForm (IngestForm.tsx) |
| `3c8637c5-416f-81ee-8d3b-c8eefbcba15d` | Consolidate 4 duplicate CI-detection (GITHUB_ACTIONS\|\|CI) implementations |
| `3c8637c5-416f-81b6-9601-e943dbc5c598` | merge-post-merge-test-gate: retry baseline checkout once before failing safe on network blips |
| `3c8637c5-416f-81d7-89e9-cc124f269e73` | CI guard: flag any scripts/clear-*.js predicate sweep with no scheduled workflow |
| `3c8637c5-416f-8112-944a-fcbada05d3d0` | Two of Tom's blog reviews reference shows not in shows.json (Edward, High Spirits) |
| `3c8637c5-416f-81af-8135-d15bbb6347a5` | Extract shared runAdvisoryAudit() helper for CI advisory scripts (crash-safety boilerplate) |
| `3c8637c5-416f-81ce-8306-e00f4c6c44a0` | P2: centralize outlet-registry.json loading behind one worktree-safe helper |
| `3c8637c5-416f-81fd-94a7-c65dd64ee781` | Consolidate inline surge guards across stale-flag sweep scripts onto the shared shouldRefuseSu… |

## Writer, caller and cost checks

The original site-side secondary Notion writes are already retired: `src/app/api/feedback/route.ts:8` describes Formspree as the processing path, and `src/app/api/submit-review/route.ts:105` writes GitHub issues. `scripts/posthog-friction-analyzer.js:13` documents the move to Linear. Existing guards are `scripts/tests/notion-live-write-paths.test.mjs` and `scripts/lib/notion-write-guard.js`. No downstream reader or production writer was patched.

The 2026-10-18 pass used one paginated Linear GraphQL dump (5,567 issues), 20 `linear-brain.js create` calls (BRO-5571 to BRO-5590) and one description update on BRO-5571 to add its acceptance criteria. Paid fetches: 0. LLM calls: 0.

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
| 2026-10-18: node one-liner over the JSON (213 rows, unique ids, verdict in the five allowed values, imported rows have a BRO id, every row has reason text) | Pass |
| 2026-10-18: getIssue for each imported BRO id, body contains the Notion page id | Pass: 20 of 20 |
| 2026-10-18: `node scripts/validate-data.js` | Exit 0 (used as evidence for the validate-data row) |

The scripts/lib batch ran before these artifacts were written, on the exact origin/main checkout, with no tracked changes. Its 16 failures therefore predate this change: 13 review-text fixture creation failures (ENOENT against the protected private-data path), 2 live-corpus drift assertions, and 1 ENOTEMPTY fixture-cleanup failure. The report counts leaf test failures; TAP also prints a failed parent suite. No source or test files were changed. No TypeScript, scoring logic, content-quality patterns or UI changes were made, so their change-specific checks do not apply.

The gh CLI has no authentication in this runner and an unauthenticated HTTP probe returned 403. The connected GitHub tool supplied the issue-state evidence successfully, so feedback triage was not blocked by that fallback failure.

## Remaining work

- File the 25 over-cap engineering rows above (evidence is in each JSON row), or decide some are not worth a card. Most are refactors or low-impact guards.
- Owner call: whether `content/reviews/edward.md` and `content/reviews/high-spirits-encores.md` need shows.json entries.
- Continue processing the seven open GitHub review submissions through their existing path.
- Reconcile the nine unlinked feedback rows with Formspree/GitHub before assigning a terminal verdict.
- BRO-5297 can close once the rows above are filed or explicitly dropped; 0 rows lack evidence text.
