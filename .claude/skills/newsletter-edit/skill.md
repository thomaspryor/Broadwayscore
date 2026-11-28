---
name: newsletter-edit
version: "1.0.0"
description: "TRIGGER when: the owner asks to change, fix, rewrite or improve the weekly newsletter's subject line, preheader, opening paragraph (lede) or other copy, for this week's draft or for future weeks; or complains about what the AI newsletter writer wrote. Gives the 3-minute path for this week's Resend draft and the exact files for changing the rules for future weeks (BRO-8064, BRO-8109)."
argument-hint: "[this-week | future] [edition]"
allowed-tools: Bash, Read, Edit
user-invocable: true
---

# Newsletter copy edits

BRO-8064 took four hours for what the owner called "just text in Resend". The fast path below existed the whole time, but no session knew about it. Use it first.

## 1. This week's draft: do this FIRST, before any code change (about 3 minutes)

The drafts are Resend broadcast DRAFTS, built each Saturday by `newsletter-draft.yml`, one per edition (`broadway` = the NYC email, `west-end` = London). Re-running that workflow with overrides PATCHes the same draft in place. It never sends.

Before you write the copy, read the draft so you know which shows and scores it holds: `git fetch origin main && git show origin/main:data/newsletter-state.json`. Check its entry for the week and edition. Every score and ranking word you write must match the cards in the email.

```bash
node scripts/cloud-dispatch.js newsletter-draft.yml \
  -f weekStart=2026-11-16 -f edition=west-end \
  -f "subjectOverride=<subject>" \
  -f "ledeOverride=<opening paragraph>" \
  --wait --timeout=35
```

- Run one edition at a time and wait for it to finish, so the run lookup cannot pick the other edition's run.
- `ledeOverride` replaces the AI intro completely. The preheader is the first two sentences of the lede.
- After it succeeds, confirm with `git show origin/main:data/newsletter-state.json` (after a fetch).
- Other one-off levers on the same workflow: `weLead` (a show id to lead the London edition), `obLead`, and `dropSections`.
- Never call the Resend API directly. The broadcast guard hook blocks it, and the auto-mode classifier refuses a self-added authorization marker. That is correct, and this workflow is the sanctioned route. Never send or broadcast to test anything (CLAUDE.md section 17).

Fix the draft and tell the owner it is done. Then do the permanent fix.

## 2. Future weeks: change the rules (one session, about 30 to 60 minutes including landing)

Pipeline: `scripts/newsletter/generate.mjs` builds the facts, then `scripts/newsletter/subject-writer.mjs` works through these steps:

1. `buildPool` picks the lead.
2. `writerPrompt` holds the rules the AI reads.
3. Claude writes candidates.
4. `checkCandidate` and `roundupProblems` reject bad ones.
5. A GPT fact-check runs.
6. A judge picks one.
7. `weekSubject` is the template fallback.

- A wording or angle preference goes in `writerPrompt`. Add a "Good" or "Bad" example there.
- Anything that must NEVER happen goes in `roundupProblems`, as a hard rejection rule. A rule only in the prompt can still slip through. Examples: a false "tops", a stale score, a thin-reviewed headline, a lede that recaps the cards.
- Add a red-then-green case to `scripts/newsletter/subject-writer.test.mjs`. Note that `checkCandidate` returns early on style problems, so a test lede must be a valid one (it names a show and its score in the first sentence), or call `roundupProblems` directly.
- Try it on real weeks without touching any draft: `node scripts/cloud-run-script.js scripts/newsletter/ai-subject-dry-run.mjs <weekStart>` (it has the API keys). Locally there is no ANTHROPIC_API_KEY, so `generate.mjs` falls back to the template.
- Run `node --test scripts/newsletter/*.test.mjs`, then the normal /ship-check, then land.

## Owner's standing rules for this copy (2026-11-23)
- A roundup week (3 or more openings) gets a week-level subject, never a one-show subject.
- NYC covers every NYC opening, Broadway and Off-Broadway equally, because Broadway openings already get their own emails.
- Shows with fewer than 10 critic reviews are not highlighted.
- No ranking word unless it is true of every score in the email.
- The lede is editorial, not a recap of the cards: at most three scores.
