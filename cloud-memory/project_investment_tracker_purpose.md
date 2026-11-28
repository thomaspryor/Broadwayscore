---
name: Investment Tracker purpose (project context, not a rule)
description: Why /biz exists: give an indication of how a show did that people can't get anywhere else, most of all when there is no public record. Read before any call on whether to show an estimate.
type: project
---

The owner, 2026-10-19 (BRO-5647): "The whole point is we give people some
indication of how it did which they can't get anywhere else [because] there is
no public record." They also said this is context about the project, not a
standing rule, and that they keep having to repeat it.

What it means in practice: where no source says how a show did, the tracker's
value is our marked best guess. Hiding the guess because nothing public
confirms it removes the feature. The guess is always marked as ours ("Likely:
Flop", "~" figures, "Estimate:" sources) and never replaces a sourced label.

Decisions that came from it:
- Did Not Recoup shows get a "Likely: Fizzle/Flop" line (2026-10-18).
- Closed Undisclosed (TBD) shows get one too, including "Likely: Recouped"
  at 100%+ returned (2026-10-19). Code: likelyOutcomeDesignation in
  scripts/lib/commercial-designations.js.

When a session is unsure whether to show a guess where the record is silent,
start from this purpose rather than asking the owner again.
- Closing Watch (2026-11-09, BRO-7246): running shows with no announced
  closing get our estimated closing month, calibrated on how long past shows
  ran once under break-even. The owner, after a session asked whether a public
  prediction was too risky: the scorecard "is not playing it safe ... we're
  bringing it together and extrapolating from it and guessing from it to give
  people information they wouldn't otherwise have." Asking was the mistake.

