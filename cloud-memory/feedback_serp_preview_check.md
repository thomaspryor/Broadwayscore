---
name: Preview SERP-facing schema content before shipping
description: "Pull 10-20 real samples before shipping schema; score gates aren't enough."
type: feedback
originSessionId: 3b81d67c-5a1d-4d9f-8921-9cecafecb56e
archived: true
---
When adding structured data that Google may render directly to users (review snippets, FAQ snippets, breadcrumbs, Q&A boxes), always sample the **actual content** the schema will emit before shipping — not just the shape.

**Rule:** Before shipping any schema with user-visible content fields (`reviewBody`, `text`, `name`, `headline`), pull 10-20 random samples from the production data that the schema will use. Read them as if they're appearing next to your brand name in a SERP. If any are wrong-tone, mid-sentence, contrastive, or off-brand, add a content gate.

**Why:** I shipped CriticReview structured data on 4/10/2026 without checking what the actual `pullQuote` field contained. A `/what-else` lens after deploy found that 34% of emitted quotes were from negative reviews and 13% started with contrastive openers like "But...", "However...", "Granted..." — mid-review qualifiers that read as pans next to the show title. Examples that would have shipped to Google:
- *"But the show shouldn't feel that way, too."*
- *"Granted, you often wish the show bared more teeth..."*
- *"But let's hope fate eventually frees him up..."*

A score-based filter alone (T1/T2 outlets) doesn't guarantee positive content — outlets pan things too. The fix was a sentiment gate (`score >= 70 OR bucket Rave/Positive`) plus a contrastive-opener regex.

**How to apply:**
- For new schema with text content, write a smoke test that pulls 10-20 random samples and prints them: `node -e "const d = JSON.parse(...); for (const x of sample(d, 20)) console.log(x.field)"`
- Read each one in isolation. If you'd cringe seeing it next to the show title in search results, gate it.
- The score/tier of the source is not enough — check the actual text.
- Also consider: contrastive openers (But/However/Still/Yet/Granted), explicit negation (not/never/hardly/barely), question marks ending the sentence (rhetorical doubt).
