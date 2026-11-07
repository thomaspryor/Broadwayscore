---
name: anti-ai-slop-writing
description: "Anti-AI-slop writing rules for any text the user will send externally or publish — emails, pitches, research pages, marketing copy. Source: tropes.fyi + user-supplied screenshot from \"AI Writing Quality Control\" guide (2026-05-26)."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6576f6b1-f5cf-46d7-892d-af5f39756f94
---

## Rule

For ANY text the user will send externally (pitches, emails to journalists/partners/press, marketing copy, public blog/research page copy), strip the AI tells before showing it to the user. Don't ship slop and hope they catch it.

**Why:** User flagged 2026-05-26 that the 5 journalist pitches I drafted overnight contained too many em dashes, "I think" hedges, and one fabricated comparison claim. Sending AI-flavored copy to external contacts undermines the project's credibility — the user explicitly invoked the "Anti-Slop Guide" rule from a productivity newsletter and asked me to load these patterns as a permanent preference.

**How to apply:** Before delivering any externally-facing text, run a self-audit against this checklist. If anything matches, rewrite.

## Anti-patterns to strip

### Sentence structure
- **Negative parallelism** — "It's not X, it's Y" / "Not just X, but Y" / "X isn't about A, it's about B." Creates false profundity. Cut entirely; state the thing directly.
- **"Not X. Not Y. Just Z."** — three-part negation. Cut.
- **"The X? A Y."** — fragmentary question-answer construction. Cut.
- **"The result? Devastating."** — dramatic fragmentation. Cut.
- **Anaphora abuse** — repetitive sentence openings (every paragraph starts with "And then…" or "I'm…"). Vary.
- **Cross-sentence reframe** — negating then repositioning nouns to manufacture insight.

### Em dashes
- **Minimize.** The user prefers commas, periods, or parentheses. Two em dashes in a 500-word email is already too many.
- Avoid mid-paragraph hard breaks via em dash.
- Avoid em-dash dismissal: "X — not Y."

### Vocabulary tells
- **delve**, **robust**, **leverage**, **unlock**, **navigate** (as a verb for "deal with"), **landscape** (figurative), **journey** (figurative), **realm**, **tapestry**, **deep dive**
- **moreover, furthermore, additionally** at sentence starts
- **It's worth noting that…**, **It's important to remember…**, **In today's fast-paced…**

### Hedges and filler
- "I think…" / "I believe…" / "I'd flag as particularly interesting…" / "I'd love to…"
- "Happy to…" as a recurring template phrase
- "Just wanted to…" / "Just reaching out…" / "Quick favor…"
- "Hope this finds you well." / "Hope you're doing well."
- "No worries if not…" / "No follow-up if not…" (overused in cold pitches — vary it)
- "Excited to share…" / "Thrilled to announce…"

### Structure
- **Bold-first bullet points** ("**X:** description, **Y:** description"). Use prose unless the list is genuinely scannable data.
- **Triple parallel structure** ("X, Y, and Z" where all three are filler nouns of similar weight). Pick the strongest, drop the rest.
- **One-point dilution** — restating a single claim three times in different words to fill space.
- **"Serves as" dodge** — passive deflective descriptions ("The building serves as a reminder…"). Just say what it is.
- **Invented concept labels** — creating neologisms or reframed terminology that sounds insightful but isn't.

### Factual hygiene
- **Never invent comparisons** ("larger than the gap on Rotten Tomatoes for film") without a source. The AI default is to add throwaway "compared to X" lines to sound authoritative. Cut them if uncited.
- If a claim isn't backed by data the user has or that I can cite, don't write it.

## Per-format rules

### Cold pitch emails
- Open with a fact or specific reference, not a greeting-shaped preamble.
- One ask per email. Make the ask in the second paragraph at the latest.
- End with a sign-off that's a name, not a flourish. No "Best," "Warm regards," "Looking forward to connecting." Just first name.
- Maximum em dashes per email: 1 (zero is better).
- If the user has a known voice sample (past emails, tweets, blog posts), match it. If not, default to direct + concrete + low-adjective.

### Research / blog page copy
- Lead with the number, not the framing. "Audiences score 7.4 points higher" not "Interestingly, audiences score…"
- No "What this means for X" wrap-up sections unless the meaning is genuinely non-obvious.
- Methodology section: short, technical, no apology.

### Marketing / docs copy
- One claim per sentence. No stacking benefits.
- No "imagine if…" / "what if…" openers.

## Self-audit before delivery

For any externally-facing text, before saying "done," ask:
1. How many em dashes? (target: 0-2 per page)
2. Any "I think" / "I'd love" / "Happy to" hedges that can be cut?
3. Any "It's not X, it's Y" or three-part fragments? (cut)
4. Any uncited comparisons or factual claims I can't back? (cut)
5. Does it read like the user could have written it, or does it read like a competent stranger?

If self-audit fails on >1 item, rewrite before delivery.
