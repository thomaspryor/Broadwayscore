---
name: in-sample-accuracy-claims-need-loso
description: Any displayed model-accuracy number must survive train/test discipline — reframe label or run LOSO before publishing
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6b313b69-4d40-4849-af82-50e64596ea82
---

When the site displays a model-accuracy %, that's a forward-looking claim that needs train/test discipline behind it. The Tony predictions model shipped 90.7% in-sample backtest as "Accuracy" on homepage + predictions pages. A Reddit critic pulled the thread — true out-of-sample (LOSO) is 83.7%, 7pp lower. Embarrassing because the framing implied predictive accuracy when the number was just historical fit.

**Why:** small-sample backtests (we have 11 seasons × 4 categories = 43 observations) over-optimize on the tuning set. With 3 fitted weights per category, in-sample typically overstates true out-of-sample by 5-15pp. Publishing the in-sample number as "Accuracy" invites the exact critique we got.

**How to apply:**
- Before putting any model-accuracy % on a user-facing surface, either:
  (a) Run leave-one-out cross-validation and display THAT number, OR
  (b) Reframe the label so the number is true regardless ("track record", "match rate", "of past winners" — facts about historical fit, not predictive accuracy claims)
- Default to (b) for marketing surfaces (homepage promos), (a) for methodology/deep pages.
- audit-tony-loso.ts is the canonical LOSO runner for Tony predictions — re-run on any recipe change.
- The same principle applies to any future model accuracy claim (lottery odds prediction, sentiment classification accuracy, etc.) — never display in-sample as a forward-looking claim.

See also: [[project-tony-predictions-accuracy]] for current LOSO numbers and recipes.
