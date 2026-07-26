# Sunday newsletter content review (pre-owner-look)

You are running headless via launchd, Sunday ~9:00am ET, before the owner
looks at this week's newsletter drafts. Your job: catch the class of bug the
owner keeps finding by hand — a lede naming the wrong show, a "RECOUPED IN 1
WEEKS" pluralization bug, a score that drifted stale between draft and now —
and fix what you can, then tell the owner what you found in three lines.

You have full tool access and `--dangerously-skip-permissions` is already
set by the launcher. Work in `/Users/tompryor/Broadwayscore` (the main repo
checkout, not a worktree — this is a review+data-fix pass, not a code change,
so the worktree-mandatory rule in CLAUDE.md §1 does not apply here).

## 0. Orient

- `git pull --rebase --autostash` in this repo (CI commits scores here often).
- Read `CLAUDE.md` if you haven't already this session — rule 17 (email
  broadcast safety) and rule 3 (critic-score canonical helper) both apply
  below.

## 1. Is there anything to review?

Run:

```
set -a; source .env; set +a
node scripts/newsletter/check-drafts-status.mjs
```

This prints `{"weekStart": "...", "broadway": "draft"|"sent"|"missing", "westEnd": "..."}`
and exits 3 if every edition that exists is already `sent`. **If exit code
is 3 (or the JSON shows no `"draft"` value at all): stop here.** Log one line
to your own stdout ("both editions already sent for week <weekStart> — nothing
to review") and end the session. Do NOT email the owner on this path — a
Sunday when the owner already sent early doesn't need a "nothing to do" email.

If at least one edition shows `"draft"`, continue.

## 2. Make sure the draft(s) reflect fresh data

Scores drift between when a draft was generated (Saturday) and Sunday
morning as CI keeps rebuilding reviews. Refresh both editions in place
(idempotent — safe even if nothing changed):

```
bash scripts/newsletter/refresh-drafts.sh <weekStart>
```

Use the `weekStart` from step 1's JSON. This re-runs generate → pre-send-check
→ overflow-check → PATCHes the existing Resend draft (never creates a new
broadcast, never sends). If it fails, note the failure in your summary email
and continue reviewing whatever HTML is on disk from step 1's `check` (or the
most recent successful generate) rather than giving up entirely.

The regenerated HTML/meta land in `$NEWSLETTER_OUT_DIR` (default
`~/Documents/claude-outputs/newsletter-mocks/A-<weekStart>.html` /
`.meta.json`) per edition — West End writes with `NEWSLETTER_EDITION=west-end`
env, Broadway without it. Read the actual `refresh-drafts.sh` source if you
need the exact per-edition invocation; don't guess flags.

## 3. Read the rendered HTML and check it against live data

For each edition that has a draft, read the generated HTML file and check:

- **Lede / subject accuracy**: does the lede/subject line name a show, score,
  or fact that's actually true right now? Cross-check any named show against
  its live composite score via `getCriticScore(showId)` semantics — i.e. read
  `public/data/shows/<id>.json`'s `cs` field (CLAUDE.md rule 3: this is the
  ONLY canonical critic score; never eyeball `reviews.json` or hand-average).
  A West End lede naming a Broadway-only show (or vice versa) is exactly the
  bug class that prompted this card — check market consistency for every
  named show.
- **Every score/number in the body** matches `public/data/shows/*.json:cs`
  for that show as of right now (post-refresh). Flag (and fix via a re-run of
  step 2, not by hand-editing HTML) anything that still looks stale.
- **Grammar / pluralization bugs** — e.g. "RECOUPED IN 1 WEEKS" instead of
  "1 WEEK". Read the generator's number-formatting helpers in
  `scripts/newsletter/generate.mjs` (search for the relevant section — Movers,
  recoupment, closings) if you find one; these are usually a missing
  singular/plural branch. Fix in `scripts/newsletter/generate.mjs` if it's a
  code bug (this touches `scripts/`, so per CLAUDE.md §1 worktree rule, make
  that specific fix in a fresh `EnterWorktree` session-equivalent: use `git
  checkout -b fix/newsletter-<short-desc>`, commit, push, and open a PR rather
  than committing straight to main from this headless run — do NOT push
  directly to `main` for `scripts/` changes even though you have
  `--dangerously-skip-permissions`).
- **Section sanity**: recoupment section cites announcements no older than
  ~30 days as "recent"; closings section doesn't list a show whose
  `closingDate` has already passed without it actually being closed
  (`status` field); no West End show leaking into the Broadway edition's
  Trending/Movers or vice versa (market field check).
- **Mobile render**: `overflow-check.mjs` (run as part of refresh-drafts.sh)
  already gates this at 375px — if it passed, don't re-derive it by hand.

## 4. Apply fixes through sanctioned lanes only

- **Data fixes** (wrong score displayed, stale recoupment %, wrong show
  named): fix the underlying data file in the appropriate data repo (see
  CLAUDE.md §11 — private repos for review texts/core data), commit, push,
  then re-run `refresh-drafts.sh <weekStart>` so the draft picks it up.
  Never hand-edit the generated HTML file directly — it will be
  overwritten by the next refresh and the root cause survives.
- **Generator code fixes** (pluralization, off-by-one date math): branch +
  PR as described above. Do not merge to main yourself in this headless
  run — leave the PR open and mention it in the summary email so the owner
  merges when they look at things. Exception: if CLAUDE.md's autonomous-loop
  infrastructure would normally auto-merge a change this small and you are
  confident it's correct and tested, you may follow that path instead — but
  a fresh PR is the safe default here.
- After ANY fix, re-run `refresh-drafts.sh <weekStart>` and re-check the
  specific issue you fixed actually changed in the new HTML. Don't claim a
  fix worked without re-reading the regenerated file.

## 5. Never touch send

You have `check-drafts-status.mjs` (read-only GET) and
`refresh-drafts.sh` → `create-broadcast-draft.mjs` (PATCH, draft-only)
available. **Never call `POST /broadcasts/{id}/send` directly, never add a
send flag, never ask the owner for permission to send.** The owner clicks
Send in the Resend UI themselves. If you're ever tempted to send "just this
once because it looks ready" — that's not your call; don't.

## 6. Email the owner a 3-line summary

Use the sanctioned single-recipient transactional pattern (CLAUDE.md rule
17 / `scripts/newsletter/send-test.mjs`'s pattern) — NOT a broadcast. Send to
`thomas.pryor@gmail.com` (or `$OWNER_EMAIL` from `.env` if set) via a direct
Resend transactional `POST /emails` call (not `/broadcasts`), plain text or
minimal HTML, subject like `Sunday newsletter review — <weekStart>`. Body:
exactly 3 lines, plain English, no jargon:

1. What you checked (both editions / just Broadway / just West End) and
   whether the drafts are ready to send as-is.
2. What you found and fixed (or "nothing wrong found" — say so plainly, don't
   pad).
3. Anything still needing the owner's judgment (an open PR to merge, a data
   question you couldn't resolve, etc.) — or "nothing else — ready to send."

If step 1 already determined there's nothing to review, you should have
already stopped without emailing (see step 1) — don't send a "nothing to
review" email on that path, only on the "I reviewed and found nothing wrong"
path.

## 7. Log and finish

Print a final one-line summary to stdout (the launcher captures this in its
log file): what you reviewed, what you fixed, whether you emailed the owner.
Then stop — do not run `/ship-check`, `/wrap-up`, or open a Notion card
sequence for this run; it's a scheduled content-review pass, not a coding
task, unless step 4 required an actual code fix (in which case treat that
one fix normally: PR, and note it in the Notion brain per CLAUDE.md §6 if
non-trivial).
