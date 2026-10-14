---
name: Audience score debugging approach
description: When audience scores seem wrong, check classifier first (not formula), then check source bias with cross-source analysis
type: feedback
archived: true
---

When audience scores seem inflated or deflated, debug in this order:

1. **Classifier quality** — run with --verbose --sample 20 and read the actual classified comments. Look for neutral dumping (should be <5%), logistics-as-negative, pre-show inclusion.
2. **Cross-source analysis** — compare every source pair head-to-head. ShowScore inflates +8 above Mezzanine (the neutral anchor) 88% of the time.
3. **Calibration target** — Reddit calibration should align with Mezzanine, not ShowScore. ShowScore is the outlier.
4. **Scoring formula** — change last. Formula changes affect all shows; classifier/calibration fixes are more targeted.

**Why:** First attempt changed the scoring formula (sentiment weights 40→20, removed +8 calibration). Caused collateral damage — EBT dropped from 86→77 despite 3 sources rating 84-98%. Reverted. The real issue was the LLM classifier dumping positive comments into neutral.

**How to apply:** When a user says "these numbers seem wrong," resist the urge to adjust weights. Check the classified data first.
