---
name: audience-grade-leakage
description: Historical Tony backtests using audience scores are partially overfit — winners accumulate inflated audience scores POST-ceremony from voters who knew they won
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 64fdf6b6-712e-4300-add7-1d0afef97a42
---

When backtesting Tony predictor recipes that use `audienceCombinedScore` / `tonyAudienceGrade` (Show Score + Mezzanine reviews), the historical accuracy is partially inflated by post-Tony review bias.

**The mechanism:** Show Score and Mezzanine review counts accumulate over years. Hamilton's audience grade today reflects 9 years of post-Tony reviews from people who knew it had won. A 2017 losing nominee has fewer cumulative reviews, biased toward early enthusiasts. The current audience grade for historical seasons is NOT the audience grade that existed at the time of voting.

**Implication:**
- Audience-heavy or audience-only recipes show artificially high in-sample accuracy
- The TRUE predictive value of audience score is lower than the 11-season backtest suggests
- For current-season predictions (no post-Tony bias yet), audience is still a legitimate input — just less reliable than backtest implies

**How to apply:**
1. When grid-search optimizes to audience-only or audience-heavy recipes, treat that as overfit warning, not validation.
2. Prefer recipes that include critic + awards signals as hedges even if backtest accuracy is slightly worse (e.g., Best Revival of a Play 0.20c/0.60a/0.20aw at 8/11 was chosen over pure-audience 10/11 because the latter is leakage-driven).
3. We can't truly fix this without timestamped review data tied to publish dates — but the bias direction is known: audience-heavy = more overfit.

**Example:** 2026-05-23 session shipped Best Revival of a Play at 0.20/0.60/0.20 (8/11 historical) over pure-audience 0/1.0/0 (10/11). Trade-off was 2 historical hits for resilience to the leakage and confident 2025-26 DoS pick.

For current-season predictions, audience scores are still legitimately predictive — the leakage only affects backtest interpretation, not next year's forecast.
