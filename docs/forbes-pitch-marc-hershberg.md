# Forbes pitch: Marc Hershberg (Commercial Scorecard)

Linear: [BRO-131](https://linear.app/broadway-scorecard/issue/BRO-131/forbes-feature-pitch-marc-hershberg-commercial-scorecard)

## Status as of 2026-08-26

The pitch already landed. This isn't a cold outreach draft, it's the follow-through. Timeline from Gmail (`Re: Broadway Scorecard call` thread):

- Feb 18, 2026: Marc submitted the site's feedback form asking for a call. Writes Forbes's business-of-Broadway column. Also Director of Business & Legal Affairs at MTI, and produces on Broadway (`& Juliet`) and the West End (`Paddington`).
- Jul 31, 2026: Tom found the lost email and replied, name-checking the Commercial Scorecard as the angle closest to Marc's beat.
- Aug 1, 2026: Marc has other pieces booked through October and asks what's on the roadmap for year-end.
- Aug 3, 2026: Tom pitches the Commercial Scorecard directly: capitalization, recoupment, and profitability across every show and season, five designation tiers, an offer to break it as a story first (not paywall it) and give Marc first look. Marc accepts, asks for launch timing.
- Aug 3-4, 2026: Tom targets an October launch; Marc counters with November 1, to pair with a Phantom of the Opera 40th-anniversary piece in October, and asks to connect "a week or so before" the article runs. Tom agrees to November 1.
- Aug 4, 2026: Last message in the thread. No specific call date locked in yet.

**Net: the ask has already succeeded.** What's outstanding is scheduling the walkthrough call (target: mid-to-late October, a week or so ahead of a November 1 publish date) and having the specific numbers ready for that call.

`/biz` is still behind the `commercial` feature flag in production (404 as of this session), consistent with holding the data for Marc's first look rather than shipping it live first.

## Briefing material for the call

Pulled from `data/commercial.json` (230 shows tracked, last updated 2026-08-24) and `data/shows.json`. Every figure below has a source in the data file; cite the file, not this memo, when it's time to hand him anything.

**Scope.** 230 productions carry commercial data. 122 have a confirmed capitalization figure, totaling $1.67B in known capital raised across those shows alone. Each entry carries per-field sourcing (SEC filings, trade press, deep-research verification passes with confidence tiers), not a single blended estimate.

**Tier breakdown across the tracked set:**

| Designation | Count | Definition |
|---|---|---|
| Miracle | 9 | Long-running mega-hit, extraordinary returns |
| Windfall | 18 | Solid hit, recouped and profitable |
| Easy Winner | 17 | Limited run, made money, low downside and low upside |
| Trickle | 3 | Broke even or modest profit over time |
| Fizzle | 27 | Closed without recouping, ~30%+ recovered |
| Flop | 61 | Closed without recouping, under ~30% recovered |
| TBD | 26 | Still running, too early to call |
| Nonprofit | 67 | LCT, MTC, Second Stage, etc. |
| Tour Stop | 2 | Not rated as an original production |

**This season's recoupments confirm Tom's own thesis from the Aug 3 email** ("limited-run stunt-cast revivals... are the only thing making money"). Of the recoupments logged since August 2025, three of six are Easy Winner limited runs, and they recouped fast:
- *Waiting for Godot* (2025 revival, $7.5M cap): opened Sep 28, 2025, recouped by Nov 2025, closed Jan 4, 2026. Recouped in roughly six weeks.
- *Art* (2025 revival, $6.75M cap): opened Sep 16, 2025, recouped and closed the same month, Dec 2025.
- *Giant* ($5.6M cap): opened Mar 23, 2026, recouped by May 2026, closed Jun 28, 2026.

Against those, the full-run musicals that recouped took far longer and carried far more capital: *The Outsiders* ($22M cap, opened Apr 2024, recouped Dec 2025, roughly 20 months) and *Just in Time* ($12.5M cap, opened Apr 2025, recouped May 2026, roughly 13 months) both landed as Windfall, not Miracle.

**The other side of the ledger, biggest capital losses on file:** *King Kong* ($36.5M, Flop), *Frozen* ($35M, Fizzle), *Death Becomes Her* ($31.5M, still unresolved, see below), *Boop* ($29M, Flop), *Water for Elephants* ($25M, Fizzle), *Tammy Faye* ($25M, Flop), *New York, New York* ($25M, Flop), *Cabaret* 2024 revival ($24.3M, Flop), *The Music Man* 2022 revival ($24M, Fizzle), *Back to the Future* ($23.5M, Flop).

**A direct callback to Marc's own reporting.** The `death-becomes-her` entry lists his October 2024 Forbes piece, "Skyrocketing Broadway Show Budgets Scare Producers," as a source. That show, the most expensive of the 2024-25 season at $31.5M, closed June 28, 2026 after a 19-month run with an estimated 70-80% of capital recovered and no trade-press confirmation of full recoupment. It's a built-in sequel: what happened to the $30M-plus shows he flagged two years ago, with the Scorecard's sourced numbers to answer it.

**Still open, TBD, worth watching into November:** *Stranger Things* ($29M cap), *The Great Gatsby* ($25M), *Maybe Happy Ending* ($18.3M), *Buena Vista Social Club* ($17M), *Cats: The Jellicle Ball* ($16.5M), *Operation Mincemeat* ($14.5M). Whichever of these move before November 1 is fresh data he can't get from a static rundown.

**Note for whoever runs the call:** refresh all of the above against the live `data/commercial.json` first. This snapshot is dated 2026-08-26; the recoupment model reruns regularly (last run in this file: 2026-08-22) and TBD shows will have moved by October.

## Draft follow-up: lock the call date

Nothing since Aug 4 has proposed an actual date. Draft below, not sent, for review before it goes out.

> Marc, following up to lock in a date. If November 1 is still the target, let's talk in the back half of October, before your Phantom piece runs. I have the Commercial Scorecard numbers ready to walk through: 230 shows, sourced capitalization and recoupment data back years, and this season's recoupments already back up the pattern I flagged, the short-run stunt revivals are recouping in six to nine weeks while the big musicals take over a year even when they hit.
>
> Would October 20-24 work on your end? I'll send a calendar link once you pick a window.
>
> Tom

## Next steps

1. Review and send the follow-up above (or a variant) to `marc.hershberg@gmail.com` to lock the October call.
2. Re-pull `data/commercial.json` numbers within a day or two of the actual call, this file's snapshot will be stale by October.
3. Decide what, if anything, ships live on `/biz` before Marc's piece runs, versus staying flag-gated for his first look per the Aug 3 offer.
