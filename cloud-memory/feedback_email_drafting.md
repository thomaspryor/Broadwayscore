---
name: Email and communication drafting rules
description: Avoid em dashes and ensure clean text formatting when drafting emails, posts, or any user-facing communications
type: feedback
---

Two rules for drafting emails, social posts, or any communications:

1. **Minimal em dashes.** Use commas, periods, or parentheses instead. Em dashes should be rare, not the default punctuation.

**Why:** User finds heavy em dash usage unnatural and overly AI-sounding.

**How to apply:** When drafting any text the user will send (emails, posts, Buffer content, Notion-facing text), rewrite sentences to avoid em dashes. One or two per email max, not one per paragraph.

2. **Clean line breaks in Gmail drafts.** Never pass terminal-width-wrapped text into the Gmail draft body. Write flowing prose with no hard line breaks mid-paragraph. Only break for actual new paragraphs.

**Why:** Warp terminal formatting inserts line breaks at ~80 chars that carry into the Gmail draft as visible line breaks, making the email look broken on the recipient's end.

**How to apply:** When calling `gmail_create_draft`, write the body as continuous paragraphs separated by `\n\n`. Never insert `\n` mid-sentence or mid-paragraph.
