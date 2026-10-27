# Social voice (BRO-6417)

The point of social is to inform people and to start a conversation. Every post, video and comment states a fact from the site first, then asks one open question that invites opinions or theories about that fact.

This file governs captions written by code (`captions.js`), hooks written by a session (`briefs.js`), the one-off `/social-post` copy, and replies once a reply generator exists. A reply follows the same rule: answer with a fact, then invite the next opinion.

## Rules

1. Inform first. The fact (score, gap, closing date, tally) comes before the question, and every number comes from `public/data/shows/<id>.json` through code.
2. End with one open question. It asks why, who, or which, so a reader can answer with an opinion or a theory.
3. Tie the question to the specific facts of this post: the gap, the split, the top scorer, the closing date. A question that fits any show is too generic.
4. Never a yes/no question and never engagement bait. Banned: "Thoughts?", "Agree?", "Tag a friend", "Like if", "Share if", "Comment below", "Drop a".
5. No em dashes. No "not X, but Y" or "it's not just A, it's B". No slop words: delve, robust, leverage, unlock, tapestry, realm, deep dive, landscape of, journey of, navigate, "excited to share", "thrilled to".
6. The code builds the question from the facts (direction and size of a gap, the tally split, the tier). A session never writes a number or a direction into a question.
7. On X and Bluesky the question outranks the caveat and the lead-in. Fit order: drop the hook, drop the caveat, shorten the title, shorten the question, and only then drop the question.

## Examples by post type

**Score post** (tier or split picks the angle)
- Good: "School Girls has a Critic Score of 84 (Critical Gold) from 32 critics' reviews. What makes it land so well with critics?"
- Good (divided tally): "14 positive, 12 mixed or negative. What's behind the split?"
- Bad: "Great reviews! Thoughts?" (no fact, engagement bait)
- Bad: "Do you agree with the critics?" (yes/no)

**London compare** (direction and size of the gap)
- Good: "Same show, two cities, an 8-point gap. Why do you think London critics warmed to it more?"
- Good (within 3 points): "Same show, two cities, and the critics largely agree. What do you think carried over so well?"
- Bad: "London critics got it right, didn't they?" (leading, yes/no)
- Bad: "Which city wins?" (no fact, invites a pile-on)

**Weekly roundup** (top scorer or the whole list)
- Good: "Maybe Happy Ending leads at 91. Which of these are you booking?"
- Bad: "Which one is your favorite?" (no tie to the week's facts)

**Closing soon** (the score and the date)
- Good: "Last chance: who has seen it, and does it live up to the 84?"
- Bad: "Hurry, don't miss it!" (pressure, no question)

**Replies** (when a reply generator exists)
- Good: answer a question with the site's number, then ask what the reader saw.
- Bad: a one-word "Thanks!".

`scripts/social-autopost.test.mjs` checks every builder on every network for the closing question and scans this file's rules (banned phrases) against the captions.
