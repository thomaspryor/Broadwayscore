---
name: feedback-newsletter-resend-broadcast-draft
description: "The weekly \"Scorecard Weekly\" newsletter ships as a Resend broadcast; create the draft with create-broadcast-draft.mjs (never send)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0765b131-552a-4e8d-b646-eaefc4d71d1f
---

The weekly newsletter ("Scorecard Weekly — <weekStart>" in Resend) IS a real
Resend **broadcast** to the **General** audience (~611 real subscribers as of
2026-06-14). Tom reviews the draft in the Resend dashboard and clicks **Send**
himself — Claude never sends.

**To get an issue into Resend (the whole flow):**
1. Generate the HTML + meta: `node scripts/newsletter/generate.mjs <weekStart>`
   (weekStart = the Monday). For a special issue, pass `SUBJECT_OVERRIDE=` and/or
   `LEDE_OVERRIDE=` env vars (e.g. a marquee opening with no critic score, or a
   post-ceremony note). Output: `~/Documents/claude-outputs/newsletter-mocks/A-<weekStart>.{html,meta.json}`.
2. Create the draft: `node scripts/newsletter/create-broadcast-draft.mjs <weekStart> --create`
   (omit `--create` for a dry run). Defaults to the General audience; `--audience=west-end|test`.
   This is **draft-only — it has no send path**. It acquires the GitHub-backed
   send lock, POSTs `/broadcasts` in draft state, prints the review URL.

**Audience IDs (verified live 2026-06-14):** General `472ec5ef-d7cc-4c48-8007-c0a6a302e7a4`
(weekly newsletter), West End `0b17260b-6a72-4a5a-a700-7b7526f18d87` (9), Broadcast
Test `b1255239-ad6e-415f-b837-4536c05c6d9b` (the ONLY safe target for a throwaway).

**Don't confuse the three Resend paths:** `send-test.mjs` = transactional `[DRAFT]`
preview to Tom's inbox only (not a broadcast). `create-broadcast-draft.mjs` = the
weekly newsletter broadcast draft. `send-opening-night-broadcast.js` = a different
product entirely. The `newsletter-draft.yml` workflow only does the `send-test.mjs`
preview — it does NOT create the Resend broadcast; that's the wrapper above.

**Why:** before 2026-06-14 there was no committed wrapper, so every week a session
re-derived the audience id / from address / unsubscribe handling / lock by hand,
or pasted HTML into the Resend UI. A session even concluded (wrongly) that no
broadcast path existed because it only searched `scripts/newsletter/` and the
broadcast-guard hook blocked its grep. The wrapper + this note kill that loop.

**How to apply:** when asked to "send the newsletter" or "get it into Resend",
run the two commands above. Never call `/broadcasts` directly (the
`block-resend-broadcasts.sh` hook blocks it; the wrapper is the sanctioned path).
Never send — Tom sends in the UI. Related: [[email-broadcast-rules]],
[[feedback_newsletter_no_utm]], [[feedback_orchestrator_pause_does_not_pause_broadcast]].
