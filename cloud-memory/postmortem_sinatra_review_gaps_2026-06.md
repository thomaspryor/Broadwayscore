# Postmortem — Sinatra (and WE opening-night) review-collection gaps, June 2026

**Audience:** the other session(s) on the discovery/completeness pipeline.
**Scope:** why "Sinatra The Musical" (Aldwych, opened 2026-06-24) repeatedly showed
fewer reviews than were published. Sinatra is the worked example; every cause is a
CLASS that recurs on every WE opening.

## TL;DR
Sinatra went 9 → 12 → 25 → 29 over four days of manual work. No jump was "new
reviews appearing" — at each step the reviews already existed on the web (often
already as files on disk) but were missed by discovery, dropped by a false flag, or
never scored. Six root-cause classes, mostly now fixed at source; the durable fix
(roundup-anchored completeness audit) is in build.

## Six root causes (each a recurring CLASS)

### 1. Discovery ran aggregators-only — SERP skipped
opening-night-reviews.yml dispatched gather-reviews with aggregators_only=true;
gather-reviews.js:~4506 SKIPS the per-outlet SERP in that mode. That SERP over the
WE London registry is the ONLY automated path to the long tail (Theatre and Tonic,
The Upcoming, FT, LondonTheatre1, North West End, Plays International). FIX: day 1-3
now dispatches FULL gather (aggregators_only=false); day 0 stays agg-only.

### 2. Dispatch guard STARVED opening shows
Old guard skipped dispatch if ANY gather run was in_progress; gather is ~always
busy, so opening shows were skipped every cron (logs: "Gather reviews already
running. Skipping."). FIX: per-show in-flight dedup via scripts/lib/gather-idempotency.js.

### 3. Consent-wall → false "not a review"
fetchWithPlaywright never dismissed GDPR/consent banners, so it captured the consent
overlay as content; the verifier correctly called THAT "not a review" and flagged the
REAL review wrongShow/not_a_review. Hit Sinatra, then Much Ado + Misanthrope. FIX:
scripts/lib/cookie-consent.js (dismissConsent) in fetchWithPlaywright — consent-specific
selectors only (no bare "Accept"), navigation guard, late-banner poll. Verified.

### 4. Star-parser miscapture → false wrong_production
Daily Mail word-stars parser read "5/5" when text said "3 out of 5"; ensemble rejected
the 5-vs-3 mismatch as wrong_production. FIX (durable): scripts/audit-star-accuracy.js
+ scripts/lib/star-parse.js. 0 hard bugs across WE after fix.

### 5. Discovered-but-never-scored (present, assignedScore == null)
Reviews written to review-texts but never reached reviews.json (scoring lagged the
surge). The MJ/All My Sons class. IMPLICATION FOR THE COMPLETENESS AUDIT: "complete"
must mean present AND assignedScore != null, never just "a file exists". Bucket
present-but-unscored as INCOMPLETE.

### 6. Unknown authors/dates at scale
Byline/date backfills capped at --limit=50 per 6h — too low for an opening surge
(~150 unknown-author + ~174 missing-date piled up). FIX: raised enrich cap 50→150 +
triggered backfills.

## Secondary classes
- Duplicate SHOW records split a production across two pages (Much Ado: "Shakespeare's
  Globe" vs "Globe Theatre", openings 2 days apart → temporal dedup saw them separate;
  canonicalVenue doesn't alias them). FIX: scripts/audit-duplicate-shows.js (CI-wired)
  + merged the two records.
- Cross-domain duplicateOf (inkl→theguardian) trips audit-duplicate-of-url-mismatch.
  Use isSyndicatedDuplicate for cross-domain syndications, not duplicateOf.
- "All That Dazzles" outlet-as-byline → real critic Daz Gale (fixed 24 files).

## Meta-cause: NO WE completeness census
audit-opening-night-coverage.js checks only 7 hardcoded WE_EXPECTED outlets, not
"everyone who reviewed it". check-opening-night-completeness.js only detects DROPS.
audit-aggregator-coverage.js covers only the 5 US aggregators. Nothing asks "the
roundup lists N critics; do we have all N, scored?"

## Durable fix (approved, in build) + must-haves
Extend audit-opening-night-coverage.js to be census-aware + MULTI-source (union
theatre.reviews/WestEndTheatre/LBO/The Stage roundup critic lists + WE_EXPECTED floor,
archive-first). Three-state verdict: complete / incomplete(list missing+URLs) /
NO-CENSUS-YET. Must-haves (cross-session, all folded in):
1. complete = present AND assignedScore != null (cause #5). Most important.
2. CADENCE: roundups publish SLOWLY (days). Empty census MUST yield no-census-yet,
   never complete (vacuous-truth trap). WE under [0,1,3,7,14]-day cadence can sit 24h
   between censuses while reviews drop within hours — densify days 0-2 to hourly (or
   extend the BW 5-min watcher / hourly gap-audit to WE).
3. Suppression stays VISIBLE: a paywalled T1 (NYT/WSJ/Observer publish 24-36h late) on
   the unfetchable list keeps the show "known-incomplete (suppressed)", never complete.
4. Dispatch chain must RE-PUBLISH: ingest-urls/gather → REBUILD → score, so new reviews
   hit reviews.json and the broadcast re-fires via workflow_run on scoring.
The census is a TARGET LIST for alerting + targeted ingest; the broad SERP discovery
(cause-1 fix) stays the ingestion ENGINE — never depend on one slow aggregator.

## Caveats the automation can't close
Search tooling is blocked from ft.com/standard.co.uk/independent.co.uk/inews.co.uk/
dailymail.co.uk/metro.co.uk. Those are caught when a roundup lists them, but if a
roundup is slow AND SERP can't see the domain, they need a manual check. Sinatra open
items: confirm Independent / The i / Metro; Evening Standard byline = Maddy Mussen
(LBO roundup's "Nick Curtis" is stale).

## Final Sinatra state
29 reviews live, cs ~64, star-accurate, census-verified near-complete. Safe to cite.
