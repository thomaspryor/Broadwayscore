---
description: Make a one-off social post the owner asked for (brief post, BRO-6368). Preview, owner approves the exact words, then it posts on all five networks through Buffer.
---

The owner asked for a social post about specific shows. This builds it from a template, shows it to them, and posts it only after they approve it in their own words. Templates today: `compare` (the same title reviewed in New York and London).

Arguments: $ARGUMENTS

## Rules

- Read `scripts/social-autopost/VOICE.md` first: inform, then invite discussion. Every caption ends with an open question that the code builds from the facts; keep any hook line in that voice (a fact or angle, never a question of its own, never "Thoughts?").
- Never write a number yourself. Every score and review count comes from `public/data/shows/<id>.json` through `brief.js`; it refuses captions with a number that is not a fact.
- Never post before the owner's approval message. Pass their words verbatim to `--approved`.
- No Buffer key is needed in the session: only the `social-autopost.yml` workflow talks to Buffer.
- A hook line (`--hook="..."`) is optional: one line, at most 140 characters, no digits, no links, no comparisons ("more", "better", "transfer"). Leave it out unless the owner asked for one.
- When the two productions opened in different years or cities, the compare template adds a caveat line on its own ("Two years apart, in different cities, with different critics, so the scores aren't a like-for-like comparison."). X and Bluesky drop the hook, then switch to the short caveat ("Two years apart, different cities and critics."), then drop it, then shorten the title, then shorten the closing question, and only then drop it, when there is no room; numbers and links always stay.

## Steps

1. Find the two show ids (`data/shows.json`): same title, one New York production and one London production.
2. Preview:
   `SOCIAL_CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/social-autopost/brief.js --preview --template=compare --a=<id> --b=<id>`
   It prints the hosted image URL, the five captions, the alt text and the 12-character hash. Look at the local PNG it names before showing anyone.
3. Show the owner the image URL and all five captions verbatim, and ask them to approve or change them. If they want changes, change the inputs (hook, show ids) and preview again; a new preview has a new hash.
4. After they approve, in the same turn:
   `node scripts/social-autopost/brief.js --post=<hash> --approved="<their exact words>"`
   It stores the approval, dispatches the workflow with only the hash, waits for the run and prints each network's state. The workflow refuses if any score or review count changed since the preview, if the same pair was posted in the last 30 days, or if either show already has a post that local day (score posts win; it picks the next free day within 3 days, else refuses).
5. Once the post's time has passed (the hourly run reads it back about 30 minutes after it goes out), check it with `node scripts/social-autopost/brief.js --status=<hash>` until every network says `sent`. Poll in the turn; do not end a turn waiting.
6. Tell the owner in plain words: what went out, when, and on which networks. End with `SAFE TO ARCHIVE` once every network says `sent` (or `ACTION NEEDED FROM YOU` if one failed and needs them).

Undo before it goes out: run `social-autopost.yml` with `cancel_queued`, or delete the post in Buffer. Stop all posting: repository variable `SOCIAL_AUTOPOST_DISABLED=true`.
