# Hard-to-collect pages: the escalation ladder (BRO-5892)

For a review page that comes back empty, a stub or a tiny shell from CI (Bachtrack, a Cloudflare challenge,
a registration wall). Walk the rungs in order and write down what each returned before concluding "no path".
Two BRO-5853 sessions got this wrong in opposite directions: one stopped at rung 1, one skipped to rung 4.

1. **Name the failing tier.** From cloud: `node scripts/cloud-run-script.js scripts/fetch-page-probe.js <url> --expect='<a phrase from the review>'`
   (runs the real `fetchPage()` chain with CI's keys; prints which tier answered and the content length). A
   175-byte answer or a "Just a moment..." title is a block, not a missing page.
2. **Rendered fetch.** Same probe with `--render`. Covers pages whose body is filled in by script.
3. **Browserbase.** Only this tier passes Cloudflare managed challenges and most anti-bot walls (~$0.10 a
   session, so keep it targeted). Probe one page first: a domain-specific probe if one exists
   (`scripts/probe-bachtrack-browserbase.js --url=...`, `scripts/probe-talkinbroadway-browserbase.js`), run
   through `cloud-run-script.js`. Copy one of them for a new domain: structure only, never print review text.
4. **Route the domain to Browserbase for good.** If rung 3 returns the body, add the domain to
   `CONFIG.knownBlockedSites` in `scripts/collect-review-texts.js` with a one-line comment naming the blocker
   and the date. That gates the cheaper tiers off for it. Then re-collect the shows' reviews
   (`collect-review-texts.yml` / `gather-reviews.yml` with `shows=<id>`).
5. **Archive.** `archiveFirstSites` in the same CONFIG: the Wayback copy often predates the wall. Worth a try
   for any review older than a few weeks.
6. **The Mac.** When every tier fails from CI IPs, the owner's browser still reads the page. Ask once, with
   everything prepared, in a Linear card starting `DECISION NEEDED:` (that line emails the owner):

   > DECISION NEEDED: N reviews of <show> on <outlet> can't be fetched by our servers (the site blocks them).
   > At the Mac, open Terminal in Broadwayscore and paste:
   > `node scripts/ingest-urls.js --show=<show-id> --urls=<file listing the URLs>`
   > It fetches each page through your own connection, writes the review files and starts scoring. About 2 minutes.
   > Or skip them: the show's score stands without these N reviews.

   Put the URL file's lines in the card. Do not ask before rungs 1-5 are written up on the card.

Never: hand-type review text into a plan or a file (copyright, and `data/pending-fixes` is public), or call a
scraper API directly instead of `fetchPage()`.
