# UK regional audit (BRO-6713), 2026-10-31

Population: 329 shows outside London (category regional at a uk-regional-venues house), 1,280 reviews, 224 scored.
Auditors: Gemini 2.5 Flash and GPT-5 mini (no Claude). Harnesses: `fact-check-historical-sample.js --cohort=uk-regional`,
`audit-review-crossmodel.js pages|score --cohort=uk-regional`, plus free checks in `uk-regional-deterministic-check.js`.
Cost (run logs): show facts $1.44 model fees plus $7.33 of search fees at list price; review pages $0.65; scores $0.27.

## Show facts (120 shows, stratified by city)
- Theatre/venue: 0 wrong of 102 checked (95% CI 0.0 to 3.6%); 18 unverifiable.
- Type (play/musical): 0 wrong of 93 (CI 0.0 to 4.0%); 27 unverifiable.
- Opening night: 119 of 120 unverifiable. Regional press nights are rarely published, so the models could not confirm them.
  321 of 329 stored opening dates come from the first review date (190 guardian-review, 131 census-review), which makes them
  a few days late against the real press night. 38 shows have a review dated before their stored opening date (up to 9 days).

## Review pages (200 sampled, page fetched and read by both models)
- Publish date wrong: 0 of 199 (CI 0 to 2%).
- Outlet wrong: 4 of 200 (2.0%, CI 1 to 5%).
- Critic name wrong: 14 of 174 (8.0%, CI 5 to 13%); most are first-name-only bylines from theatreandtonic.co.uk where the page shows a full name. 26 stored without a critic.
- Review belongs to a different house or production: 19 of 200 (9.5%, CI 6 to 14%). Of the 19, 8 are RSC productions filed
  under the Royal Shakespeare Theatre that actually played the Swan or The Other Place (one venue entry by design, not an error).
  The other 11 are the same title reviewed at a different theatre (Traverse, Underbelly, Melrose, Southwark Playhouse,
  Soho Theatre, Riverside Studios, St Ann's Warehouse NYC, Lyceum): real mis-attributions or tour stops that should not count.

## Scores (154 reviews, 140 scoreable)
- Mean drift vs the two models +1.0, mean absolute drift 4.7 points.
- Bucket disagreement: 10.0% by both models (14 of 140, CI 6 to 16%), 16.4% by either (23 of 140).
- The two largest gaps (20+ points) are 3/5 star reviews stored at 60, which is inside the 51 to 70 band the repo requires.

## Free checks (all 329 shows)
- Duplicate productions, close-before-open, previews-after-open, status vs closing date: 0 found.
- Stars outside their band: 1 (the-prime-of-miss-jean-brodie-royal-lyceum-regional-2026, 5/5 stored as 70).
- Review URLs naming a different house: 12 (tour stops or wrong attribution, same population as the page audit).
