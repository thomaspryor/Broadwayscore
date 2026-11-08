# BRO-7103 plan: continuous-improvement loop (recurring problem classes)

Owner direction (2026-11-07, verbatim): "ensure most or all of our work is not just spot fixing but fixing root causes and adding systems to improve things. Continuous improvement". OWNER-PLAN-APPROVED recorded on BRO-3425 (parent).

## Context
- Next.js 14 site + ~1,000 node scripts; board is Linear (team BRO). Daily CI: `.github/workflows/data-health-check.yml` (cron 02:15 UTC, LINEAR_API_KEY, isolated commit steps for data/audit outputs).
- Exists and reused: `scripts/lib/linear-client.js` (graphql, updateIssue, createComment, listIssuesByProvenance), `scripts/lib/linear-issue-create.js` (createLinearIssue, twin reuse), `scripts/lib/start-now-filing.js` (START-NOW line), `data/audit/alert-ledger.json` (2,574 conditions; per conditionKey firstSeen / incidentOpenedAt / resolvedAt / linearIdentifier; incidentOpenedAt > firstSeen means it reopened after a resolve: 163 such keys), `scripts/lib/linear-done-gate.js` + linear-brain.js Done gate (line ~499, already prints `gate.warning`), `scripts/lib/cloud-worker-pick.js` skipReason/pickCloudCard, `scripts/health-check.js` runCheck rows -> health-digest-snapshot.json (morning digest), `scripts/check-health-row-absent.js`.
- No existing card-class detector, no PREVENTION recorder in repo (Gate 6 is a Mac hook; claims live in Outcome comments on cards).
- Known conflicts: BRO-7102 (sibling, running) is adding a cause tag on test-yml:red card closes. This plan adds NO cause-tag field; it reads BRO-7102's when present. Coordination comment goes on BRO-3425.
- Data at hand (prototype, 60 days): 3,977 cards; a crude title normaliser gives 57 classes with 3+ cards covering 671 cards. Top: e2e canaries (168, expected), main test.yml red unit tests (45), review gap (87 across "bsc daily:" + plain), canary marker (39, expected), opening-night audit/watch <date> (63, expected), watchdog parked redispatch (39), commercial data pending review (22), national tour pages (14).

## Design
1. `scripts/lib/recurrence-classes.js` (pure, unit-tested):
   - `classKey(title)`: lowercase; strip filer prefixes ("bsc daily:", "auto-fix:", "[auto]"...); replace BRO ids, dates, shas, numbers, quoted segments, parentheticals with placeholders. Quoted segment = per-instance signature (test name, show), so all "main test.yml red: unit tests / ..." collapse to one class.
   - `EXPECTED_REPEATS`: list of {pattern, reason} (e2e canaries, canary marker, "opening-night audit/watch <date>", "week in review", dependabot lands, morning/opening digest liveness checks are NOT expected — they are failures). Expected classes are reported but never escalated.
   - `detectClasses(cards, ledger, {now, windowDays:30, minInstances:3})` -> classes {key, instances[], countInWindow, firstSeen, lastSeen, ledgerReopens[], recurring, reasons[], rootCause}. RECURRING = 3+ instances created in the window, OR any linked ledger condition reopened after resolve inside the window. Ledger keys join a class via the card they filed (linearIdentifier).
   - Root-cause card for a class = an open or done card whose description carries `<!-- root-cause-class: <key> -->`, or a static `ROOT_CAUSE_OVERRIDES` map (main test.yml red -> BRO-3425) so pre-existing structural cards are reused, never duplicated.
   - `preventionClaims(card, comments)`: extract `PREVENTION:` lines from description + comments of Done instance cards; a claim FAILED when another instance of the class was created after that card's completedAt.
   - `workKind(card, classes)`: 'root-cause' (carries the marker / override / label `root-cause`), 'instance' (member of a class with 2+ instances, or auto-filed: alert-ledger-linked or filer prefix), else 'system' (one-off build). Root-cause share = (root-cause + system) / Done in the last 7 days.
2. `scripts/recurrence-detector.js` CLI:
   - Reads Linear (cards created in the last 60 days, archived included, + comments for Done instances of recurring classes only) and the ledger.
   - `--backtest --days 60`: replays day by day; for each class records the first date it would have been flagged; writes `data/audit/recurrence-backtest.json` + `docs/recurrence-backtest.md` (hit list, flag date vs today, expected-repeat exclusions, false-positive review).
   - default (dry run) prints the plan of writes. `--apply`: for each recurring class without a root-cause card, files ONE card via createLinearIssue (title "Root cause: <class>", marker, linked instances, counts, dates, failed PREVENTION claims, START-NOW line, safe VERIFY = `node scripts/recurrence-detector.js --check-class <key> --quiet`, which exits 0 once the class has had no new instance for 21 days); for classes that already have one, updates a single bot-owned section of its description (idempotent, marker-delimited) and adds `related` relations to new instances. Caps: max 3 new root-cause cards per run (oldest-flagged first), the rest wait for the next day. Kill switch `RECURRENCE_DETECTOR_DISABLED=1`.
   - Always writes `data/audit/recurrence-classes.json`: classes, instance->rootCause map, weekly trend history (root-cause share, open recurring classes, failed-prevention count), generatedAt.
   - `--check`: safe-form VERIFY: exits 0 when recurrence-classes.json is < 36h old and every recurring class has exactly one root-cause card; 1 otherwise. This replaces the card's placeholder VERIFY.
3. Close-gate (advisory, §19): new pure `recurrenceCloseWarning(identifier, classesFile, relations)` in recurrence-classes.js; linear-brain.js Done path and linear-session.js report path print `⚠️ recurring class <key>: link root-cause card BRO-N before closing (advisory; blocking from 2026-12-01)` and append to `data/audit/linear-gate-bypass.jsonl`-style advisory ledger? -> no: just print + count in the next detector run (detector counts Done instances in recurring classes lacking a relation to the root-cause card; shown in digest row). Blocking flip is a dated constant + a recheck card, not automatic.
4. Worker routing: `skipReason` in scripts/lib/cloud-worker-pick.js gains `recurring-class:<rootId>` when the candidate is an instance whose class root-cause card is open and pickable, so the picker moves on (the root-cause card is START-NOW so it is picked first). P0 instance cards are NOT skipped (an outage still gets fixed).
5. Digest row `Improvement: root-cause share` in scripts/health-check.js reading recurrence-classes.json: pass when share >= target and no failed preventions in 7 days, warn otherwise; message "Root-cause/system work X% of Done (7d, was Y% last week); N recurring classes open; M failed preventions". Target 60% initially (to be revisited after 3 weeks of trend).
6. CI: one step in data-health-check.yml (continue-on-error, timeout 10 min) running `node scripts/recurrence-detector.js --apply`, plus its own isolated commit of the two data/audit files before later push steps.
7. Tests: `scripts/lib/recurrence-classes.test.mjs` (fixtures: canary excluded, main-red collapse, ledger reopen, idempotent root-cause detection, prevention failure, work-kind shares, close warning).

## Ramp
1. Backtest + dry-run by hand, review hit list and false positives, tune EXPECTED_REPEATS.
2. Land detector with --apply capped at 3/day, close-gate advisory, routing, digest row.
3. RECHECK 21 days after landing: trend in digest, root-cause cards created/closed, false positives.

## Out of scope / later
- Grouping by files touched by fixing commits (title + ledger only in v1; add if classes fragment).
- Blocking close-gate (dated flip after the advisory period).

## Plan review 2026-11-07 (6 reviewers: gpt-5.4-mini, Gemini 2.5 Flash, 4 Claude panelists) and revisions

Phase 0: approach sound; first step is already the smallest unit (backtest + dry run by hand before any write). /right-problem not run separately: the owner's request and the 30-day evidence on the card fix the problem statement.

| Change | Reason | Source |
|---|---|---|
| Class key = `card-dedupe.js titleKind()` after stripping auto-fix filer prefixes; no second normaliser | Existing classifier for flood/rollup; two would drift | structure, design (both P1) |
| Marker is versioned (`root-cause-class: v1:<key>`); a root card is also matched by instance overlap (its listed instances) | Key changes would orphan root cards and file duplicates | pre-mortem, design |
| main-red keeps per-job classes (titleKind gives "unit tests run", "e2e tests run" ...); all map to BRO-3425 via a title-prefix override | Respects BRO-3865's per-signature split; no 2nd structural card | structure |
| Ledger reopen counts only conditions with a recorded resolve before the reopen (resolvedAt/resolveReason), not the 96h gap reset | 49 of 163 "reopens" were gap resets | structure |
| Backtest replays card counts day by day; ledger reopens only for the current window (ledger keeps latest incident only) | Ledger has no history | structure |
| Root-cause card VERIFY = `--check-class`; card text tells the worker to land the prevention then Pause with RECHECK-AFTER +21d (the nightly acceptance recheck runs it) | Done gate runs VERIFY at close; 21 quiet days cannot pass at close time | design, pre-mortem |
| Root cards filed P1 + START-NOW; routing skips an instance only while its root card is In Progress or a fresh (<48h) START-NOW Todo; P0 never skipped; decided in pickCloudCard with the snapshot injected | Starvation and pickability; skipReason is pure | user impact P0, pre-mortem, structure, design |
| Close warning lives in linear-done-gate.js (`warning`), so linear-brain.js and linear-session.js both get it; a link = root id named in description/comments/close comment (no extra Linear call); blocking from 2026-12-15, after the 2026-11-29 recheck | Two callers; recheck before block | design, user impact |
| Digest row is informational (always pass), plain-English owner text, with a playbook entry; never warn, so digest-autofix never files a card for it | warn rows auto-file cards (digest-autofix.js:551) | design P1, user impact P0 |
| `--apply` aborts on any failed/partial Linear read; output carries `complete`; `--check` fails on `complete:false` | partial reads give false "clean" | pre-mortem |
| Detector runs before the health-check step; its two files get their own isolated commit step and a merge-registry entry | stale digest row, stranded commits | pre-mortem |
| Root cards filed through createLinearIssue with the dedupe opt-out so they are never folded into a twin | near-dup reuse could swallow them | structure |
| Prevention stats also count Done instances closed with no PREVENTION line | after-the-fact only otherwise | structure |
| Cap: 3 new root cards per run; digest message says how many are waiting | first-run backlog | user impact, gpt |
| Not in v1 (filed as cards): router re-pointing a ledger condition's tracker to the root card; files-touched grouping | router change is its own infra review | structure |

Gemini P0 ("expected repeats contradiction") was a misreading of one sentence; the sentence is fixed above: digest-liveness failures are NOT expected repeats.
