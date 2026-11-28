---
name: Public site need not cite every source
description: Commercial figures and labels can go public on a reasonable estimate or a private tip, no public citation or certainty needed; record the source privately. Don't ask the owner to approve a hedged tip.
type: feedback
---

Owner rule (2026-10-27, BRO-6446): the public website does not have to cite all
of our sources. Internally (in the private data repo: `commercial.json`
`sources`, notes, Linear) we can and should record where every figure came
from, including private tips from industry contacts (e.g. Ben Waterhouse /
Boring Waltz on Hamilton's ~30x investor return).

**Why:** some of our best inputs are friends and insiders who will not be
quoted publicly. Requiring a public link threw those figures away.

**How to apply:**
- A figure with only a private source may still be shown publicly. Record the
  source privately (who, when, what they said) so it can be audited.
- Do not name a private contact on the site unless they agreed to be named
  (BRO-6245: a producer's snapshot is used but never attributed).
- Write a tip down when it arrives (show, figure, who, date) in the record's
  notes or the Linear card. Several older labels (MJ, Next to Normal, West
  Side Story, In the Heights) have no recorded basis, so a tip that shaped
  them could not be found later (BRO-6446).
- Never invent a source, and never show a figure with no source at all, public
  or private.
- Code that hides a figure for lacking a public URL (e.g.
  `getReportedInvestorMultiple` in `src/lib/commercial-display.ts`, which needs
  a cited trade/SEC URL) is stricter than this rule; loosen it deliberately,
  not by faking a URL.
- Supersedes the "a quotable forum post counts" wording for `recouped: true`
  only in that the citation may be private.

**Reasonable estimates are the product (owner 2026-10-30, BRO-6559, repeated to
many sessions):** the site exists to give people information that is not out
there otherwise. A credible tip or a sound estimate is enough to set a figure
or label; 100% certainty is not the bar. When an insider says a show
"probably" recouped, apply it and
record the tip privately. Do not turn it into a DECISION NEEDED. Still never
invent a figure, and keep labelling our own estimates as estimates.
