# BRO-3699: ticketing platform source audit

Checked 2026-10-29 against the operators' own support, legal, product or about pages. The starting allowlist contained 13 hosts, including both Ticketmaster storefronts.

No additional resale-only marketplace was found. Eleven hosts demonstrate primary ticket sales and remain allowlisted. Two stale hosts no longer demonstrate theatre ticket sales and were removed from `TICKETING_PLATFORMS`, without labeling them resale marketplaces.

| Starting host | Finding and action | First-party source and evidence |
| --- | --- | --- |
| todaytix.com | Primary ticket agent; retain. | [US terms, Services and Features](https://www.todaytix.com/us/terms) describe selling tickets on behalf of event providers or third parties. [UK terms, About us and How we work](https://www.todaytix.com/uk/terms) describe theatre-authorized sales and access to the theatre's inventory. |
| ticketmaster.com | Primary sales plus resale; retain. | [Standard Purchase Policy, Overview and section 2](https://help.ticketmaster.com/hc/en-us/articles/10465798887953-Purchase-Policy?tm_link=help_nav_3_online) distinguishes initial sales for event organizers from tickets resold by fans and professionals. The policy explicitly identifies Ticketmaster as the primary provider for standard tickets. |
| ticketmaster.co.uk | Primary sales plus resale; retain. | [Purchase Policy, sections 1.2, 1.4 to 1.6](https://www.ticketmaster.co.uk/legal/purchase.html) distinguishes inventory allocated by event partners from tickets sold on by original buyers through its ticket exchange. |
| telecharge.com | Authorized primary seller; retain. | [Telecharge's owner, The Shubert Organization, About Telecharge](https://shubert.nyc/about-us/shubert-family/telecharge/) identifies Telecharge as its division and the official authorized seller, with box-office pricing rather than reseller markups. Telecharge's own About page rendered no readable body, so the operator's page supplies the evidence. |
| ovationtix.com | Venue ticketing software; retain. | [OvationTix's official redirect to AudienceView](https://audienceview.com/ovationtix-is-now-audienceview/) identifies the former brand, retains the `admin.ovationtix.com` login and describes box-office ticketing, event creation and online ticket sales. This is the product operator's current page. |
| eventbrite.com | Organizer ticketing platform; retain. | [Terms of Service](https://www.eventbrite.com/help/en-au/articles/251210/eventbrite-terms-of-service/) describe organizers creating events and selling tickets, with Eventbrite processing payments for them. The indexed terms were readable; opening the terms returned HTTP 429. [Create an event](https://www.eventbrite.com/help/en-us/articles/551351/how-to-create-an-event/) independently explains creating the event, ticket types and organizer settings. |
| smarttix.com | Unrelated utility software; remove. | [Current About page](https://smarttix.com/about/) describes software for utility locators, engineering and land surveying, and field technicians. This is not evidence of theatre ticket sales and does not establish resale activity. |
| ticketcentral.com | Default hosting page; remove. | [Current site](https://ticketcentral.com/) serves a Plesk default page, describing web hosting tools rather than ticket sales. The `www` and About attempts were inaccessible. No current primary or resale service was established; similarly named domains are not evidence about this host. |
| universe.com | Organizer ticketing platform; retain. | [Buying tickets](https://support.universe.com/hc/en-us/articles/360002596452-Buying-tickets) describes the same event checkout on Universe, the organizer's website and partner sites, with organizer-configured ticket types and checkout information. |
| showclix.com | Event ticketing software; retain. | [Operator Leap's Terms of Service, preamble and section 2](https://checkout.conventions.leapevent.tech/terms) explicitly cover `showclix.com` and describe processing ticket sales and admissions for event promoters and venues. Direct ShowClix terms attempts were inaccessible; the operator's current terms supplied the evidence. |
| ticketleap.com | Organizer ticketing platform; retain. | [Purchase Agreement, sections 1 and 2](https://www.ticketleap.com/legal/purchase-agreement/) describes listing events submitted by organizers and processing authorized ticket orders; the organizer controls prices, availability and seating. |
| seetickets.com | Primary ticket agent plus Fan-to-Fan resale; retain. | [Consumer Terms and Conditions, introduction](https://purchase.seetickets.com/content/partial/terms-and-conditions) describes sales for promoters, artists, venues and producers, and separately sales for members of the public through Fan-to-Fan. |
| ticketsource.co.uk | Organizer ticketing platform; retain. | [Customer Purchase Policy, section 1](https://www.ticketsource.co.uk/kb/terms-of-use/customer-purchase-policy) redirects to the operator's `ticketsource.com` policy. It describes software and payment infrastructure for event organizers; the purchase contract is between organizer and customer. |

## Classification boundary

Primary ticket sales qualify a platform for this allowlist even if it also offers resale. Ticketmaster's two storefronts and See Tickets therefore stay eligible. The predicate matches hosts, show titles and markets; it does not inspect seat inventory or promise that every ticket on a mixed platform is a primary ticket. Removing these legitimate primary sellers wholesale would not be a correct resale-only classification.

GoTickets and BoxOfficeTicketSales were already in `RESALE_HOSTS` on main, as BRO-3636 intended. That correction was left intact. [GoTickets' own support article](https://support.gotickets.com/support/solutions/articles/154000234849-am-i-purchasing-tickets-directly-from-the-venue-team-or-performer-) confirms that its marketplace lists tickets from professional resellers. The regression test explicitly retains coverage for both BRO-3636 hosts.

## Verification and real-data impact

Before the change, `platformForUrl()` classified `https://smarttix.com/about/` as SmartTix and `https://ticketcentral.com/` as Ticket Central. `pickTicketUrl()` accepted both with a matching result title. The new acceptance test initially failed 3 of 21 tests: allowlist membership and rejection of each stale host. After removing the entries, all 21 tests pass.

The supplied `data/shows.json` contains 4,478 shows and 1,051 ticket links. Running the real `platformForUrl()` and `pickTicketUrl()` functions on every existing ticket link before and after produces **zero changed records**. Neither removed host occurs in the current ticket links, so no private-data fix plan or backfill is needed. Representative unchanged selections:

| Show ID | Platform | Selected URL |
| --- | --- | --- |
| the-lost-boys-2026 | TodayTix | https://www.todaytix.com/nyc/shows/43812-the-lost-boys-on-broadway |
| schmigadoon-2026 | Ticketmaster | https://www.ticketmaster.com/schmigadoon-ny-tickets/artist/3985079 |
| dukes-off-broadway-2026 | OvationTix | https://ci.ovationtix.com/35583/production/1278008 |

The writer is `scripts/enrich-fallback-ticket-links.js`: it imports the discovery predicates, selects with `pickTicketUrl()`, checks redirects using `platformForUrl()` and writes `show.ticketLinks`. The change is in that caller's allowlist, so both initial selection and final-host verification use it.

Acceptance: `node --test tests/unit/ticketing-platforms-resale.test.mjs`. The test imports the real library, checks every retained host, rejects resale hosts and stale hosts including subdomains, rejects suffix spoofs and verifies fallback to a primary result. It makes no network calls. `scripts/lib/unit-test-collection.js` automatically collects it for CI.

Verification results:

- `node --test tests/unit/ticketing-platforms-resale.test.mjs`: initially could not find the file on main; after adding the test, 18 passed and 3 failed against the old allowlist; after the fix, 21 passed and 0 failed.
- `node --test --test-timeout 300000 tests/unit/ticketing-platforms-resale.test.mjs scripts/lib/ticket-link-discovery.test.mjs scripts/enrich-fallback-ticket-links.test.mjs`: 51 passed and 0 failed.
- `node --import tsx --test --test-timeout 300000 scripts/tests/tm-gap-links.test.mjs`: 8 passed and 0 failed. This file is already in `tests/unit-test-manifest-tsx.txt`. Running it with plain Node instead fails to resolve the existing `@/config` alias; the test and its imported `src/lib/ticket-utils.ts` are unchanged from main.
- `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet`: the gate failed only `lint-committed-pii`, which reports 6 findings against a baseline of 5 in `data/audit/we-historical-tr-probe.json`. Re-executing the linter source from `origin/main` produced the same exit 1 and finding count. The linter, dependencies and audit inputs are unchanged from main. Actionlint is not installed in this environment and was skipped by the harness. No unrelated data or lint rules were changed.
- `git diff --check`: passed. No TypeScript files changed.

Cost: zero new paid fetches, LLM calls or API calls per enrichment run. This was a one-time manual web research pass. The existing enrichment runs in `update-show-status.yml`, whose schedules are daily at 08:00 UTC and Wednesday at 06:00 UTC; no workflow or schedule was changed.
