---
name: feedback_stale_flag_collision_drops_current_production
description: "Stale-flag collision guard silently dropped every fresh WE review that had a prior-production file; the systemic West End \"only 6 reviews\" failure"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5069eb8a-8362-42e1-8109-2bc515299bd5
---

The recurring West End opening-night failure ("6 reviews, all minor blogs; every
major critic missing; needs manual intervention every time" — ~20 shows, 30+
sessions) was NOT a discovery/gathering failure. Discovery works. The reviews die
at the WRITE step.

**Root cause (2026-07-04, To Kill a Mockingbird Wyndham's 2026):** the poller
discovered 18 reviews and netted +0 — 15 rejected. `detectIngestCollision`
(`scripts/lib/manual-review-fields.js`) blocked any incoming review when an
existing same-outlet file was flagged `wrongProduction`/`wrongShow` with a
different URL, **with no check on whether the INCOMING review was the current
production.** West End is dominated by revivals / returns / transfers reviewed by
the SAME critics (Nick Curtis, Clive Davis, Arifa Akbar…), and its major outlets
are paywalled (leaving stale `textLen:0` files). So every major outlet had a
prior-production file (TKAM: 2018 Broadway + 2022/2023 Gielgud), and every fresh
2026 review collided → dropped. Only outlets with no prior-production file (small
blogs) survived. The Evening Standard's fresh 2026 review was found via RSS and
dropped by `stale-flag collision with standard--nick-curtis.json` (the 2022 file).

**Why 30 sessions missed it:** prior fixes patched the *re-discovery* gate
(`getKnownUrls`/`getFoundOutletIds` skip wrongProduction files) so discovery FINDS
the reviews — but they die one step later at the *write* gate, which nobody traced.
Manual intervention "works" only because deleting the stale files removes the
collision, masking the bug. The symptom (low review count) is many steps downstream
of the cause.

**Fix:** thread `openingDate` into `detectIngestCollision`. When the incoming
`publishDate` is in the opening window (opening−90d .. opening+365d) it is provably
the current production → suppress the stale-flag and >365d-gap blocks and write to a
clean file. `findExistingReviewFile` already skips wrongProduction files as merge
targets, so no flag inheritance (Beaches 2026-04-22 protection holds). No
openingDate / dateless incoming → conservative block preserved. Threaded through
`gather-reviews.js` (poller) and `ingest-review-from-url.js` (automated URL ingest).

**Why:** the guard conflated "duplicate of a flagged prior-production file" with
"the legitimately new production's review." The discriminator (incoming date vs
opening) was sitting in the guard's own debug output, unused.

**How to apply:** when a show has few reviews but the review-texts folder is full of
outlet files, DON'T assume gathering failed — check the poll log for
`stale-flag collision` / `Rejected: N` in the "POLL CYCLE RESULTS". Trace
discovery→WRITE, not just discovery. For revivals/returns of previously-staged
titles, prior-production files are EXPECTED; the pipeline must distinguish them by
the incoming review's date, not block on filename/outlet collision. Related:
[[feedback_pending_no_byline_strand_drain.md]], [[feedback_llm_wrongprod_false_positives.md]],
[[feedback_review_recovery_pipeline_gaps.md]].

**Secondary WE gaps found same session (not yet fixed):**
- `THESTAGE_COOKIES` missing in CI → The Stage (T1 UK) can never be fetched for any
  WE show. Needs user's cookies (see [[feedback_stage_cookie_minimal_set.md]]).
- launchd `opening-night-backup-trigger.sh` only dispatches `market=broadway` — West
  End has no local backup when GHA crons lag/drop.
- Aggregators (Show Score, WestEndTheatre, theatre.reviews) return the PRIOR
  production's page for revivals — limits the aggregator layer for returning shows.
