---
name: Public site need not cite every source
description: Commercial/recoupment figures can go on the public site without a public citation; every claim still needs a private, internal source record.
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
- Never invent a source, and never show a figure with no source at all, public
  or private.
- Code that hides a figure for lacking a public URL (e.g.
  `getReportedInvestorMultiple` in `src/lib/commercial-display.ts`, which needs
  a cited trade/SEC URL) is stricter than this rule; loosen it deliberately,
  not by faking a URL.
- Supersedes the "a quotable forum post counts" wording for `recouped: true`
  only in that the citation may be private.
