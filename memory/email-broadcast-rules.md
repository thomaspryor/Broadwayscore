# Email Broadcast Safety — full history

See CLAUDE.md §17 for the mandatory rule list. This file is the incident
history behind it.

## Incident: unmarked test send landed as a real-looking email (BRO-3577, 2026-09-15)

**What happened:** while building `scripts/send-btc-confirmation-emails.js`
(BRO-1325), a session manually verified the email by sending it for real via
Resend to the owner's own address, using the unit-test fixture value
(`{'Best Musical': 'Foo'}`) and the exact production template — subject
`Your 2026 Tony Award Picks (confirmed)`, copy claiming "Sorry for the
delay — here's the confirmation you should have gotten back in June." It
landed in the owner's real inbox at 23:17, three minutes before the feature
commit (23:20:19). Nothing distinguished it from a real send to a real
contest entrant. The owner forwarded it back with: "No sessions should be
sending emails like this to any people. Ever."

**What did NOT go wrong:** the actual bulk send (to all 300 real entrants)
never happened — the session correctly held it back pending an owner
go/no-go, which was still open in Linear (BRO-1325, state: In Progress) at
the time of the incident. The `beat-the-critics-confirmation-sent.json`
checkpoint file has never existed in the private data repo's git history,
confirming a full run never ran. The failure was narrower and more subtle:
a *single test send*, sent to an address CLAUDE.md §17 explicitly endorses
for testing (`--send-to=your@email.com`), using real production copy with
zero visual distinction from a real send.

**Root cause:** the existing rule ("test via `--send-to=your@email.com`,
transactional, never broadcast") only constrains *where* a test send goes,
not *what it looks like once it arrives*. A test send of a fully-rendered,
narratively-complete transactional template ("confirmed", "sorry for the
delay") is indistinguishable from a real one in an inbox — the recipient
has no way to know it was a test without reading source code.

**Fix:** `scripts/lib/test-send-marker.js` (`markTestSend({subject, html})`)
prefixes the subject with `[TEST] ` and prepends a visible orange banner to
the HTML. Wired into the `SEND_TO` (single-recipient) path of
`scripts/send-btc-confirmation-emails.js` and `scripts/send-btc-results.js`
— the two scripts that render a full real-content template and accept
`--send-to=<email>` for manual verification. `scripts/send-opening-digest.js`
was NOT touched: its `--send-to` is a legitimate recipient override for the
owner's own real daily digest, not a test of entrant-facing copy.
`scripts/send-opening-night-broadcast.js` was NOT touched either: its
`--send-to` is a deliberate, owner-wanted preview of the real upcoming
broadcast content (BRO-227 rationale in the file), a different and already
-justified use case.

**Prevention for other sessions:** any new script that sends a real,
narratively-complete email (confirmations, results, receipts — anything
that reads as "this really happened") to a single address for manual
testing MUST call `markTestSend()` on that path before it reaches
`sendEmail()`/Resend. Don't hand-roll a different marker — reuse the lib so
`[TEST] ` + banner styling stays consistent and greppable.

## Policy: unsent opening-night drafts (BRO-2935, owner decision 2026-10-11)

Three July West End drafts (To Kill a Mockingbird, Jesus Christ Superstar,
Trainspotting) sat unsent in Resend for months. Nothing flagged them because a
draft looks "handled" to every tracker check. Policy:

- An opening-night draft nobody sends gets DELETED, never sent late. Use
  `discard-broadcast-draft.yml` (dry run by default; `dry_run=false` to act).
  It refuses unless every tracker record of the draft is unsent, every show of
  a combo draft is named, and a live Resend GET says `draft`. It never calls
  `/send`.
- Discarded records keep their history and get `discardedAt`
  (`markDraftDiscarded` in `scripts/lib/broadcast-state.js`). Every consumer
  treats them as resolved: the send filter, deadline re-queue, reconcile,
  missed-broadcast check and recreate guard all skip them. `discardedAt` is a
  recency field, so a stale tracker copy cannot resurrect the draft on merge.
- `check-missed-broadcasts.js` (daily, data-health-check.yml) pages one
  `broadcast:draft-unsent:<draftId>` alert per draft that is 3 to 30 days old
  and still `draft` on a live GET, skipping shows already in a never-sent alert.
