# Email Worker: Multi-Machine Coordination

**Status:** Live as of 2026-04-10. Safe to run on multiple machines.
Worktree isolation for `[fix]`/`[deep]` added 2026-07-28.

**File:** `~/.claude-email-worker/poll.py`

## The problem this solves

The worker polls Gmail at `thomas.pryor+claude@gmail.com` every 5 minutes via
launchd and replies to each new task. Prior to 2026-04-10, "already processed"
state lived in a **local file** (`~/.claude-email-worker/processed.json`). With
two machines running the worker (Mac Studio + MacBook), neither knew what the
other had processed — both could claim the same unread message and send
duplicate replies. The workaround was to disable the MacBook entirely.

## The coordination protocol

A single Gmail label — **`claude-processed`** — is the cross-machine source of
truth for "claimed." Local `processed.json` remains as a belt-and-suspenders
dedupe but is no longer authoritative.

### What happens on every poll

1. **Label setup (once per machine).** `ensure_label(imap, "claude-processed")`
   calls IMAP `CREATE` for the label. Result is cached in
   `~/.claude-email-worker/label-cache.json` so subsequent polls skip the call.
   Gmail IMAP also auto-creates labels on first `X-GM-LABELS` STORE, so the
   explicit CREATE is belt-and-suspenders.

2. **Search filters out claimed messages.** The IMAP search uses Gmail's
   `X-GM-RAW` extension to run a Gmail web-search-syntax query:

   ```
   X-GM-RAW "to:thomas.pryor+claude@gmail.com newer_than:1d -label:claude-processed"
   ```

   The `-label:claude-processed` clause means any message already claimed by
   any worker on any machine is invisible to this search.

3. **Per-candidate claim sequence.** For each message the search returns:

   - **a. Local dedupe pre-check.** If its `Message-ID` is in `processed.json`,
     skip (guards against stale Gmail search indices).
   - **b. Snapshot labels BEFORE modify** (`get_gmail_labels`). If
     `claude-processed` is already present, another worker beat us between
     search and claim — log `"Lost race: ... already has claude-processed
     label from another worker (pre-claim)"` and move to the next candidate.
   - **c. STAMP the label.** `STORE +X-GM-LABELS "claude-processed"` — this is
     the claim, and it happens BEFORE any `claude -p` work begins. The operation
     is idempotent, so if two workers race the second one is a no-op.
   - **d. Verify via re-fetch.** Re-fetch labels; if `claude-processed` isn't
     now present, log `"Label verification failed ... skipping to be safe"` and
     move on.
   - **e. We won** — log `"Claimed <msg-id> via claude-processed label"` and
     process the task normally.

4. **No cleanup step at the end.** Because we stamped the label before
   processing, the message is already marked as claimed for every future poll.
   `processed.json` still gets updated on completion / error as a second
   layer of dedupe.

## Why this works across machines

The label lives on Gmail's servers, not on either machine's disk. A STORE
`+X-GM-LABELS` from Mac Studio is immediately visible to a search from the
MacBook (and vice versa), because both are IMAP-connected to the same mailbox.
The `-label:claude-processed` filter in the search query then shrinks the
candidate set to only unclaimed mail.

## Residual race window

There is a small window between step 3b (snapshot) and step 3c (stamp) — on
the order of the network round-trip for the STORE call. If two workers start
polling at the exact same second and both get past step 3b before either
stamps, both will stamp (idempotent) and both will proceed to process.
Realistic probability with independent 5-minute launchd crons on two machines
is effectively zero (<1 collision per several years of operation), and
`processed.json` on each machine catches a second-processing-attempt for
messages a single worker has already seen. Good enough for this use case.

## Why has_gmail_label exists (parser-failure black hole)

The label-presence check uses `has_gmail_label()`, which tries the parsed
label list FIRST and falls back to a substring search on the raw IMAP
response. This dual path is not paranoia — it prevents a real silent-drop
failure mode:

> If `get_gmail_labels()` ever fails to parse the X-GM-LABELS response (label
> name containing `)`, multi-line server response, imaplib tuple framing
> quirk, etc.), the parsed list comes back empty. Without the fallback, the
> verification step after STORE would see an empty list, conclude "label not
> stamped, skip to be safe", and `continue` — but the STORE already
> succeeded, so the label IS on the message in Gmail. The message is now
> permanently invisible to all future polls (search filter excludes it) AND
> the worker that stamped it walked away. Silent black hole.

The substring fallback in `has_gmail_label` makes this impossible: even if
the regex parser misses the label, the literal label name is still in the
raw response bytes, so the verify step succeeds and processing proceeds.

If you ever see `Label verification failed for ... — skipping to be safe`
in the log, that's an actual STORE failure, not a parser glitch.

## Re-enabling the MacBook as hot standby

The MacBook launchd plists are renamed to `.disabled` at
`~/Library/LaunchAgents/com.broadwayscore.claude-email-worker*.plist.disabled`.
To bring it back as a hot standby:

```bash
cd ~/Library/LaunchAgents
mv com.broadwayscore.claude-email-worker.plist.disabled com.broadwayscore.claude-email-worker.plist
mv com.broadwayscore.claude-email-worker-health.plist.disabled com.broadwayscore.claude-email-worker-health.plist
launchctl load com.broadwayscore.claude-email-worker.plist
launchctl load com.broadwayscore.claude-email-worker-health.plist
```

Send a fresh test email. You should see one machine log `"Claimed ... via
claude-processed label"` and the other log `"Lost race: ... already has
claude-processed label ..."` (or just `"No new tasks found"` if it polls
after the claim landed — the search filter would already exclude the claimed
message).

## Worktree isolation for `[fix]` / `[deep]`

Separate from the label protocol, but it shares the same motivation: another
process on the same machine must never be able to clobber this one's work.

Write-capable tags (`[fix]`, `[deep]`) no longer run in the shared
`~/Broadwayscore` working tree. The old path did `git stash` →
`git checkout -b` → `git stash pop` in main. With ~20 parallel worktree
sessions live on this machine at any time, that `stash pop` could pop a
*different* session's stash and destroy its uncommitted work. `[info]` and
untagged (read-only) tasks still run in `REPO_DIR` — they never write.

What happens now:

1. **`create_worktree(slug)`** — `git fetch origin main`, then
   `git worktree add -b worktree-email-<slug>-<timestamp>
   .claude/worktrees/email-<slug>-<timestamp> origin/main`. Branching from
   `origin/main` means the PR is against current remote state; if the fetch
   fails (offline) it falls back to local `main`.
2. **Gitignored runtime deps are symlinked in** (`WORKTREE_LINKED_DEPS` =
   `.env`, `node_modules`) so the session can still run `npx tsc` and scripts
   that read `.env`. Deliberately NOT `review-texts` — scripts resolve that to
   `~/broadway-review-texts`, and the in-repo copy is a stale independent
   clone (`memory/feedback_review_texts_not_symlink.md`).
3. **Claude runs with `cwd` set to the worktree**, so every Edit/Write lands
   inside it.
4. **`finish_worktree(...)`** — `git -C <worktree> status --porcelain`, then
   `add -A` → `commit` → `push -u origin <branch>` → `gh pr create` (run with
   `cwd` = the worktree). Everything in the worktree is by definition this
   task's work, so there's no file-by-file filtering and no stash.
5. **Cleanup is success-gated.** The worktree is removed only after a
   successful push; `git worktree remove` leaves the branch behind because the
   branch backs the PR. If the task changed nothing, the worktree AND its empty
   branch are both deleted (`git branch -D`). If `add`/`commit`/`push` fails,
   the worktree is **kept on disk** and the failure path is quoted in the email
   reply so the work is recoverable.

Failure modes worth knowing:

- **Worktree creation fails** → the task is downgraded to a read-only `info`
  run rather than being allowed to write into main.
- **Thread follow-ups reuse the worktree** if it still exists (recorded as
  `workdir` + `branch` in `sessions.json`). Because `claude --resume` is
  cwd-scoped, a recorded worktree that has since been removed (the normal
  outcome after a successful PR) means the resume is dropped and a fresh
  session starts in a new worktree.

## Things that are NOT part of this protocol

- **Thread→session resume** uses `sessions.json`, which is local per machine,
  so session resume is best-effort per-machine. A reply that arrives on a
  machine that did NOT process the original will start a fresh session.
  Acceptable tradeoff — fixing it would require sharing `sessions.json` across
  machines, which is out of scope. (Its records now also carry `workdir` and
  `branch` for worktree reuse — see the section above — but that's orthogonal
  to the label protocol.)
- **Reply handling, attachment extraction, tag dispatcher** — all unchanged.
- **launchd plists, health check, lock file** — all unchanged.

## Files touched by this protocol

- `~/.claude-email-worker/poll.py` — claim sequence, label helpers, search query
- `~/.claude-email-worker/label-cache.json` — remembers which labels we've
  created (currently just `claude-processed`)
- `~/.claude-email-worker/processed.json` — still present as belt-and-suspenders
  dedupe; no longer authoritative

## Quick diagnostic commands

```bash
# Is the label on recent messages?
python3 -c "
import imaplib
from pathlib import Path
env = dict(l.split('=',1) for l in (Path.home()/'.claude-email-worker'/'.env').read_text().strip().split('\n') if '=' in l and not l.startswith('#'))
imap = imaplib.IMAP4_SSL('imap.gmail.com')
imap.login(env['GMAIL_ADDRESS'].strip(), env['GMAIL_APP_PASSWORD'].strip())
imap.select('\"[Google Mail]/All Mail\"')
print(imap.search(None, '(X-GM-RAW \"label:claude-processed newer_than:1d\")'))
"

# Watch the log for lost-race events
grep -i 'lost race\|claimed.*via claude-processed' ~/Library/Logs/claude-email-worker.log | tail -20
```
