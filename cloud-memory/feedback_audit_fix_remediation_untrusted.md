---
name: feedback-audit-fix-remediation-untrusted
description: "An audit's own --fix advice corrupts scores in BOTH directions; require a reviews.json inclusion diff before any remediation"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3a408323-4555-48ce-a357-5797dbc93810
  modified: 2026-08-15T02:36:12.406Z
---

Never run an audit's `--fix` on the review corpus on the strength of its own failure
message. Two separate remediations were caught on 2026-08-14, both recommended by the
gate that was failing, both score-corrupting in opposite directions:

- `audit-stale-flag-after-url-correction.js --fix` newly **INCLUDED** 8 genuinely
  wrong-production reviews into live Critic Scores (a 2019 Trafalgar Studios Equus at
  score 97 landing on the 2026 Menier production). That remediation has since been
  deleted from the repo outright.
- `audit-self-contradictory-clears.js --fix` would newly **EXCLUDE** 563 reviews, 438
  carrying live score signals, including NYT/Brantley, WSJ/Teachout, The Stage and the
  FT. It deletes the clear breadcrumb while leaving the exclusion flag standing, so
  `content-quality.js` marks them `contentTier: 'invalid'`.

**Why:** these audits detect a *state*, not a *verdict*. A record can match the pattern
while its flag is entirely correct. `!fullText` in particular does NOT mean "no
evidence" — `aggregatorStars` / `showScoreExcerpt` / `assignedScore` make a bodyless
record fully scoreable.

**How to apply:** before ANY bulk remediation, snapshot `reviews.json`, apply in a
DISPOSABLE copy (never run `rebuild-all-reviews.js` against the canonical clones),
rebuild, and diff. Require zero unintended newly-included AND newly-excluded reviews,
and `scoring-delta.js` reporting `Newly INCLUDED: 0`. If even one review moves
unintentionally, stop. Classify first: how many matches are date-corroborated, how many
carry a score signal, how many are genuinely stale — usually only the third group is
safe.

Prefer a **committed baseline band** over an absolute ceiling for these gates
(`data/audit/self-contradictory-clears-baseline.json`, 776 ±25). A `--max=N` one record
from the live count flaps main red on a corpus the bots mutate every ~30 min, and a
total-count alarm far above its ceiling can never fire at all — it detects nothing while
looking like enforcement.

Related: [[feedback_scoring_delta_required]], [[feedback_includability_predicates_must_be_canonical]],
[[feedback_manual_review_protection_fields]], [[feedback_test_yml_push_path_allowlist]]
