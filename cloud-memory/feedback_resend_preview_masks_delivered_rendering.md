---
name: feedback_resend_preview_masks_delivered_rendering
description: "The Resend dashboard/browser preview does NOT reflect delivered-email rendering — verify webp, dark mode, badge contrast in the real client"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3d72ec4d-40f9-4de1-af10-d0cbb60d87dc
---

The Resend broadcast dashboard (and any browser-based email preview) renders in a
**browser engine**, so it shows webp fine, applies no dark-mode inversion, and
makes the newsletter look correct even when the delivered email is broken. It
**masks** what real mail clients do.

Two incidents, 2026-07-05, both from trusting the preview / documented behavior
instead of the delivered client:
- Claimed webp breaks Gmail, shipped a weserv image proxy + memory — **wrong**,
  modern Gmail renders webp. The preview hid that images were always fine.
- Gmail iOS force-inverts the dark-designed newsletter (page `#0f0f14`, cards
  `#1a1a24`) and ignores its `color-scheme:dark only` / `[data-ogsc]` hardening,
  breaking score-badge contrast — invisible in the preview.

**How to apply:** for ANY email-rendering claim (webp, dark mode, badge/text
contrast, font fallback), verify in the actual delivered client — the owner's
Gmail iOS via a self-send is the test target — BEFORE diagnosing or shipping.
Never ship a client-rendering fix and call it done off a browser preview. General
verify-first principle: [[feedback_verify_bug_claim_before_fixing]]. Newsletter
send flow: [[feedback_newsletter_resend_broadcast_draft]].
