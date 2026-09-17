# Session state — BRO-2600

## Done (verified, merged, nothing to resume)

BRO-2600 ("BSC Daily: Quality: DMARC deliverability") is **fully complete**:
- `_dmarc` TXT record on broadwayscorecard.com tightened to `p=reject` via the Vercel DNS API.
- `scripts/lib/dmarc-record.js` + `tests/unit/dmarc-deliverability.test.mjs` added as a regression gate.
- Merged to `origin/main` at `4612b3962d6`. `git log origin/main..HEAD` is empty in this worktree — fully merged, nothing to push.
- Linear issue BRO-2600 reported `status=done` via `node scripts/linear-session.js report`.
- Post-merge CI (run 35283526542) investigated: the only failing jobs (Data Validation, Test Summary) are a pre-existing, unrelated data bug (4 west-end shows with bad titles/missing type, traced to an automated `gather-reviews` commit in the private data repo). TypeScript/Unit Tests/Lint/E2E all passed.

**If resuming: there is nothing left to do for BRO-2600.** Do not re-open work on it.

## Adjacent findings filed (not part of BRO-2600)

- **BRO-3712** ("P0: GMAIL_REFRESH_TOKEN revoked — Daily Gmail Ingest (DMARC + finance) failing 10+ days straight") — parked via `--park`, needs owner interactive Google OAuth. Full runbook on the card.
- **BRO-3713** ("P1: 4 West End shows failing Data Validation gate — LBO sitemap promotion has 2 bugs (missing type + garbled titles)") — filed with `--dispatch`, which is a **no-op for Linear cards** (task #1303, "P0: Linear has no dispatch path — file-a-card-and-work-it dies with Notion"). Root cause + suggested approach are on the card.

## Blocker preventing this session from closing cleanly

`~/.claude/hooks/exit-status-gate.sh`'s Gate O v2 (dispatch-ownership check) is blocking session close. It fires because `linear-brain.js create --dispatch` was run for BRO-3713, which its own session-wide `is_dispatch_command` detector treats as "this session dispatched work" — permanently, for the rest of the session, regardless of what actually happened.

**Verified via the repo's own sanctioned arbitration tool that nothing was actually dispatched:**
```
$ node scripts/ack-landed.js --id BRO-3713 --sha <HEAD> --verify "node scripts/validate-market-expansion.js" --reason "..."
❌ REFUSED: BRO-3713 not acked — no dispatch-ledger row for this ref — nothing was dispatched under it

$ node scripts/ack-landed.js --id BRO-3712 --sha <HEAD> --verify "node scripts/validate-market-expansion.js" --reason "..."
❌ REFUSED: BRO-3712 not acked — no dispatch-ledger row for this ref — nothing was dispatched under it
```
Also confirmed directly: `grep -c "BRO-3713" data/audit/dispatch-ledger.jsonl` → 0 rows. `cmux list-workspaces` → no match.

Gate O v2 requires, for every `DISPATCHED:` id: either a `LANDED:` line backed by a `job-done`/`landed-acked` ledger row, or an `OWNED BY: workspace:N ("...")` naming a live cmux workspace. Neither is truthfully available: no ledger row exists (nothing was dispatched) and no cmux workspace exists (this is a headless `-p` job with no workspace of its own). This looks like a genuine gap in Gate O v2 for the case where `--dispatch` was passed to a tool that is a documented no-op for Linear (task #1303) — the trigger fires on the flag alone, not on whether a dispatch actually happened.

**Next session / owner: this is a hook/tooling gap, not unfinished BRO-2600 work.** Either:
1. Fix Gate O v2 to accept `ack-landed.js`'s own "nothing was dispatched under it" refusal as proof there's nothing to own (rather than treating a refused ack as "still uncovered"), or
2. Fix `linear-brain.js create --dispatch` to not present as a dispatch command to `is_dispatch_command` when it's a documented no-op (i.e., only exercise the `--dispatch` code path, and whatever marks it as a dispatch, once bsc-next actually supports Linear — task #1303).

No code changes are needed to close out BRO-2600 itself — it's done. This file exists only to record why the session may end without a clean `THIS SESSION: CLOSE ME` if the gate loop doesn't resolve.
