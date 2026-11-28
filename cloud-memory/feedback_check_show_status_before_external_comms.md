---
name: check-show-status-before-external-comms
description: "Before drafting/sending any external communication about a show (user reply, pitch, newsletter mention), check and surface the show's status and closingDate first — user was burned when a reply to a producer went out without flagging the show had already closed"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 97a4bc9a-29b7-4f90-8a44-371e69f1aa89
---

Before sending ANY external communication that references a specific show (feedback replies, producer/press emails, newsletter inclusions), look up the show's `status` and `closingDate` in shows.json AND sanity-check against review text (closing dates often appear in article boilerplate: "runs through …"). Surface the status to the user alongside the draft.

**Why:** 2026-07-12 — replied to Misterman producer Kirsten Weiss about score fixes without noticing the show had closed 7 days earlier. The closing date ("runs through Sun July 5") was literally in the FRC review text quoted earlier in the same session. User: "That would have been good to know before sending the email!" Compounding factor: shows.json was stale (status still `open`) because OB closings have no automation ([[feedback_closing_date_audit_gaps]]), so trusting the data field alone is not enough for recently-opened OB shows.

**How to apply:** When drafting show-related external copy: (1) print the show's status/openingDate/closingDate next to the draft; (2) if status is `open` but the show is a limited/festival run (OB, regional, "trial production"), grep the show's review texts for "runs through|closes|final performance" and reconcile; (3) put any closure/timing fact in the DECISION NEEDED block so the user sees it before approving the send.
