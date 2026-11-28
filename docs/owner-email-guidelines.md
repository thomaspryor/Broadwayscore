# Writing an email to the owner

The owner reads email on a phone, between other things, and is not technical. These rules apply to
any session (Claude or Codex, cloud or Mac) that sends the owner an email, a status report or
otherwise. They are guidelines; nothing blocks a send. BRO-6285.

## The rules

1. **The first line says what this is and whether anything is needed.** For example: "Status: the
   ad-permission fix is live. Nothing needed from you." or "One decision is waiting on a card for you."
   If the owner reads only that line, they should know whether to keep reading.

2. **Never ask a question in a free-form email.** File a card that starts with
   `DECISION NEEDED: <plain-English question>` (the decision rule in `.claude/CLOUD.md`). The system
   emails that card with tap buttons (one per option, plus "Reply in my own words"). The owner answers
   by tapping one, or by commenting `ANSWER: <words>` on the card; both are picked up and recorded. Before you file, run
   `node scripts/lib/owner-decision-recall.js "<topic>"`: the owner may already have answered.
   - Never write "reply yes to Claude" or "reply to Codex". A chat reply reaches one named session
     only, the owner cannot tell which one you mean, and nothing reads a reply to the email itself.
   - A child session sends its question to its parent session instead.

   - A step only the owner's hands can do (a setting with no API such as App Store Connect privacy
     answers, a cookie renewal, an identity check like AdSense) goes out as a TASK, never as a chat
     ending (BRO-6654). First try Remote Control (`list_computer_folders`, `request_computer_folder`).
     If that is not available: on the work card (P1, not `--mac-only`, no PARKED line naming the Mac,
     with its usual safe VERIFY) add `DECISION NEEDED: <the task in plain words>`, a
     `Why this is your call:` line saying why Claude cannot do it, and `Owner step 1:`,
     `Owner step 2:` ... lines, one plain action each with the exact URL and setting. No Option lines.
     Then `linear-session.js report --status=paused` and end. The email says "Task for you" with
     Done / could-not buttons; a Done tap sends the card to the front of the cloud worker queue for 48 h.

3. **One ask per email.** If a status email mentions a decision, give one plain-words
   recommendation and say what happens if the owner does nothing, then point at the card.

4. **Plain English.** No card ids, file paths, command names, branch names or jargon in the body.
   If a term is unavoidable, explain it in a few words ("data-center traffic, meaning visits from
   rented cloud servers rather than people").

5. **Say who wrote it and where to look.** Name the session or tab ("from the AdSense setup tab")
   and give one link the owner can open: the card or the page that changed.

6. **Status reports are welcome and short.** Three things: what changed, what is still running, and
   what is needed from the owner (usually nothing). Numbers only when they change a decision.

7. **Write the way the owner writes.** Follow the owner's anti-slop rules (installed in every cloud
   session as `~/.claude/anti-slop-rules.md`). In short: no em dashes, no "not X, but Y" or "it's not
   just A, it's B" constructions, no hollow intensifiers, no praise or greeting openers, direct
   sentences of varied length, and sign off with just a name or nothing.

## Bad example

This email was sent to the owner on 2026-10-26. Its subject was "AdSense trial: GA4 shows ~80% bot
traffic (one decision for you)". Shortened:

> Your GA4 key works. The check it made possible found that about 80% of GA4's traffic is bots.
> US data centers: ~120,000 fake sessions in 28 days. They show up as "direct" traffic on
> Chrome/Windows, stay about 3 seconds, and come from cloud-server towns (Virginia, Iowa, Arizona,
> Oregon, Wyoming). [...] Singapore: ~21,000 fake sessions. [...] Your real audience is solid. GA4
> counts 17,574 engaged sessions and PostHog 17,709. [...]
>
> The decision: before the 50/50 launch, should the firewall also: 1. add Singapore to the
> China/Hong Kong rule, and 2. add a rule for data-center traffic (Vercel's built-in bot protection,
> plus cloud-provider networks like AWS, Google Cloud and Azure)? Both would start in Log mode for 3
> days, then switch to Challenge [...]
>
> My recommendation: yes to both. Reply "yes" to Claude or Codex. Codex is already handling the
> firewall, and it's noted on BRO-5893.

What went wrong:

- The first line does not say a decision is needed; that is buried four paragraphs down.
- It asks the question by email and says "reply yes to Claude or Codex". The owner cannot reply to a
  specific session from email, so the answer had nowhere to go.
- Two questions in one ask, wrapped in jargon (GA4, PostHog, Log mode, Challenge, AWS).
- A card id instead of a link, and no word on which tab or session wrote it.
- Most of the body is numbers the owner does not need to make the call.

## Good example (the same email, rewritten)

> Subject: AdSense: one decision waiting for you (blocking bot traffic)
>
> This is from the AdSense setup tab. One decision is waiting for you on a card, with buttons.
>
> Most of the site's measured traffic turns out to be bots running on rented cloud servers. Your real
> audience is steady, about 17,500 engaged visits in the last four weeks. The bots matter because Google can limit an
> ad account that shows many ads to bots.
>
> The decision: block that bot traffic before ads start, watching for three days first and then
> blocking for real. I recommend yes. Real visitors almost never browse from cloud servers, so the
> risk to them is low. If you do nothing, nothing is blocked and the firewall work waits; the
> request for Google's review goes ahead either way.
>
> Decision card: <link to the card>
>
> Claude, AdSense setup tab

Why it works: the first line says what it is and that one decision is waiting. One plain sentence says why
it matters. The recommendation and the default are stated. The question lives on a card with
buttons, there is one link, and the sender is named.
