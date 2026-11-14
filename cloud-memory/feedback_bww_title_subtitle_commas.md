---
name: BWW RR slug matcher — subtitle separator is often a comma, not a colon
description: BWW Review Roundup slugs drop everything after `:` OR `,` in a show title — stripSubtitle in bww-rr-discover.js must split on both or the match silently fails
type: feedback
originSessionId: 2261174c-b03c-4540-838b-ff1aae19d452
archived: true
---
BWW Review Roundup slugs are authored without subtitles. The separator in shows.json titles is inconsistent — some shows use `:` ("The Fear of 13: Starring Adrien Brody"), others use `,` ("Beaches, A New Musical"), others use `—`. The subtitle-stripper must split on all of them.

**Why:** Beaches 2026-04-22 opening — shows.json title was "Beaches, A New Musical", real BWW slug was just "BEACHES". Initial fix split on `:`/`—`/`-` only (first pass of the Beaches postmortem fix). The match still returned false against the canonical shows.json title until the regex was extended to include `,`.

**How to apply:**
- Character class for `stripSubtitle` in `scripts/lib/bww-rr-discover.js` is `[:,—–\-]`. Keep it.
- When adding a new Broadway show with a subtitle, the separator choice does not matter for BWW discovery — but do NOT introduce new separators (bullet, semicolon, em-dash-with-spaces) without extending the regex AND adding a regression test.
- Verify fix by running:
  ```
  node -e "const { slugMatchesShow } = require('./scripts/lib/bww-rr-discover.js'); \
    console.log(slugMatchesShow( \
      'https://www.broadwayworld.com/article/Review-Roundup-BEACHES-Opens-on-Broadway-20260422', \
      { title: 'Beaches, A New Musical', openingDate: '2026-04-22' } \
    ))"
  ```
  Expected: `true`. If false, the regex dropped a separator.

**Related:**
- `tests/unit/bww-rr-discover.test.mjs` — Beaches regression test covers colon AND comma forms.
- Postmortem: Notion card `P0: Beaches opening-night 2026-04-22 postmortem`.
