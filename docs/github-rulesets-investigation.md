# BRO-424 — GitHub Rulesets investigation

**Status: INVESTIGATION ONLY. No live branch-protection changes made or proposed for immediate application.** This document is the deliverable for BRO-424 (deferred by the owner 2026-08-18, tracked as backlog). A future session must run `/plan-review` against the plan section below before touching live rulesets.

**Reviewed via `/plan-review` 2026-08-26** (5 of 6 reviewers — Gemini unavailable, `GEMINI_API_KEY` not set in this environment). Findings are folded into this version; see the "What changed after review" section at the end for the full list and sourcing.

## Why this exists

BRO-378 found that classic branch protection's `required_status_checks` rejects any direct push of a fresh commit outright (`GH006: Required status check "Lint Workflows" is expected`), independent of `enforce_admins` or the pushing identity — confirmed live against a real production workflow (Update Deploy Watermark, run 32087193625), reverted within 3 minutes. See `scripts/setup-branch-protection.js` header and `memory/feedback_branch_protection_direct_push.md` for the full incident. Both concluded that real enforcement requires migrating direct-push workflows off `git push origin main`, with "GitHub Rulesets with a bypass-actor list" named as the likely mechanism but left untested. This card tests that claim.

## Finding 1: the "~300 workflows" figure overstates this repo's actual exposure

The BRO-378 header cites "~300 direct-push-to-main workflows" as the migration surface. That figure is **not the count of workflows pushing to Broadwayscore's own `main`** — it's inflated by cross-repo pushes to the private data repos (`broadway-scorecard-data`, review-texts, aggregator-archive), which are separate GitHub repos with their own independent branch protection and are out of scope for a ruleset on `thomaspryor/Broadwayscore` (the repo `scripts/setup-branch-protection.js` actually targets, `DEFAULT_REPO`).

Initial hand-grep counts (2026-08-26) landed on ~20 workflow files, but a Codex code-review pass on this document caught **two of those 20 were wrong**: `finance-ingest.yml` has `permissions: contents: read` and only ever clones/pushes to the separate `broadway-scorecard-data` repo via a manual `/tmp` clone using `REVIEW_TEXTS_TOKEN` — it never touches this repo's main. `diagnose-shallow-fetch.yml` is read-only (`contents: read`) and doesn't push anywhere; the earlier grep matched it only because a *comment* in the file mentions `push-with-retry.sh`, not an actual invocation. A follow-up recount (`grep -lE "(bash|sh)\s+scripts/lib/push-with-retry\.sh"` instead of a bare substring match) found **142** files that actually *invoke* the script, not 154 — the original count also included files that only mention it in comments.

**This is itself the headline finding, not a footnote: hand-grepping which workflow pushes to which repo is not reliable enough to drive a live migration.** A workflow can check out multiple repos across different jobs/steps, use a composite action in one job and a manual clone in another, or only reference the push helper in a comment. The corrected, defensible number for "workflows that push directly to `thomaspryor/Broadwayscore`'s own main" is **~18, with medium confidence** (`brand-mention-monitor.yml`, `check-cron-health.yml`, `check-cwv-health.yml`, `check-flag-parity.yml`, `check-push-ledger.yml`, `daily-digest.yml`, `diag-fetch-timing.yml`, `guard-no-orphan-commit.yml`, `monitor-scheduled-email-count.yml`, `monitor-gate-ab.yml`, `stage-latency-rotation.yml`, `test-ugc-roundtrip.yml`, `ux-walkthrough.yml`, `weekly-nyt-critics-picks.yml`, `scrape-dtli-show-score.yml`, `regenerate-tier-configs.yml`, `audit-aggregator-gap.yml`) — **but the implementation card's first deliverable must be a small audit script** (per-job: what does this job's `actions/checkout` target, does this job's push step push to that same target) that produces an authoritative list mechanically, not another hand-count. Excluded categories still hold: `mirror-*-to-gitlab.yml` (push to `gitlab.com`, not GitHub, 3 files) and `purge-archives-history.yml` (force-pushes arbitrary archive/tag refs, already blocked by `allow_force_pushes: false` regardless of ruleset decisions).

This still matters for cost even with the correction: the migration surface for *this* card is on the order of **~18 workflow files**, not 300 — the other push-with-retry.sh call sites target other repos and are each that repo's own future card, not this one. But treat "~18" as an estimate to be confirmed by tooling, not a final list to migrate off of directly.

## Finding 2: all of them push as the default `GITHUB_TOKEN` — one identity, not eighteen

Checked every workflow in the corrected Finding 1 list for its checkout/push token: all use the implicit default `GITHUB_TOKEN` (a few pass it explicitly as `secrets.GITHUB_TOKEN`, most rely on `actions/checkout@v5`'s default). None use a custom PAT for pushing to this repo's own main (`REVIEW_TEXTS_TOKEN` and friends are for the *other* repos). Where they set a commit identity at all, it's `github-actions[bot]` / `github-actions[bot]@users.noreply.github.com`.

This means the bypass surface is conceptually **one identity**, not eighteen separate migrations — good news for cost, bad news for the mechanism (see Finding 3).

## Finding 3: the default `GITHUB_TOKEN` identity cannot be put on a Rulesets bypass list

This is the load-bearing fact for the whole plan, verified against current GitHub documentation (docs.github.com, retrieved 2026-08-26) and multiple GitHub Community discussions:

- Ruleset bypass-list actor types are: **Repository admins/org owners/enterprise owners, a repository role at or above `write`/`maintain` (including custom roles), a Team, a GitHub App (`Integration`), or Dependabot.** There is no actor type for "workflows using the default `GITHUB_TOKEN`."
- The default `GITHUB_TOKEN` push is attributed to a synthetic `github-actions[bot]` identity that is **not a selectable bypass entity** — it isn't an installed GitHub App with an App ID you can add via `actor_type: Integration`, and it isn't a real repository collaborator with a role. Multiple GitHub Community threads (e.g. "Allowing github-actions[bot] to push to protected branch", #25305) confirm this is a known, unresolved gap, not a configuration mistake on this repo's part.
- The two workarounds GitHub documents/the community uses are:
  1. **Register a real GitHub App**, install it on the repo, mint an installation token per-run via `actions/create-github-app-token` (or equivalent), and add that App's ID to the ruleset's bypass list with `actor_type: Integration`.
  2. **Use a PAT belonging to a real account** (a dedicated bot/machine user, or in principle a human's PAT) that holds `write`/`maintain` on the repo, and put that role or the account itself on the bypass list.

Rulesets do **not** remove the `required_status_checks`-blocks-fresh-commits problem BRO-378 hit — that's a property of status checks needing a check run recorded against the exact pushed SHA, and Rulesets use the same underlying mechanism as classic protection for that rule type. The only way an identity avoids it is by being on the bypass list entirely (bypassing *all* rules in the ruleset, not just the PR-review one), which is exactly why the bypass-actor mechanism, not a Rulesets-specific check-satisfaction trick, is the real lever here.

## Finding 4: migration cost estimate

Given Findings 1–3, migrating is **not** "edit 300 workflows." It's:

1. **One-time setup (not per-workflow):** register a GitHub App (or designate a machine-user PAT) for `thomaspryor/Broadwayscore`, store its credential as an org/repo secret, add it to the new ruleset's bypass list (`bypass_mode: always`, so it also covers non-PR direct pushes, not just PR merges). **This bypass list must also include the human owner/admin identity** — Rulesets, unlike classic protection's `enforce_admins` toggle, enforce against repository admins by default unless explicitly exempted. Missing this is the single biggest risk in this plan: the instant `required_pull_request_reviews` goes active, every direct `git push` from a human terminal or Claude Code session (this repo's entire operating model, per CLAUDE.md) is rejected too, not just the bot's. Verify in the GitHub UI, before any apply, exactly who is and isn't covered.
2. **Per-workflow change:** in each workflow the audit script from Finding 1 confirms pushes to this repo's main, swap the implicit `GITHUB_TOKEN` for the new App/PAT token. This is a mechanical edit at each site, but **do not migrate all of them in one shot** — see the ramp below.
3. **Then, and only then,** create the new ruleset with `required_pull_request_reviews` for humans and the bot identity (and the human admin identity) on the bypass list.

**Rollout ramp (added after review — the original draft of this section proposed migrating everything then flipping the ruleset in one motion, which multiple reviewers flagged as the same "test 2-3, ship the rest untested" pattern that caused the BRO-378 outage):**

1. Migrate **one** low-stakes, non-monitor workflow first (`guard-no-orphan-commit.yml` — chosen because it isn't itself part of the failure-detection chain, unlike `check-cron-health.yml`, which would go dark exactly when something breaks if it were the untested one).
2. Create the ruleset in GitHub's **Evaluate mode** (logs what would be blocked, doesn't actually block) and confirm the bypass fires as documented — this whole plan currently rests on GitHub Community discussion posts, never verified live against this org.
3. Flip to Active for that one workflow's traffic only if possible, or accept a short window and monitor closely.
4. Once the bypass is confirmed live and working, migrate the remaining ~17 files, each verified by re-running the workflow once and confirming a real push landed (not just "the job went green" — `regenerate-tier-configs.yml`'s existing retry loop, `... || sleep`, already exits 0 even when every retry failed, per Codex's review of this document; that's a pre-existing bug independent of this migration and worth its own follow-up card, but it's exactly the kind of false-green this rollout must not trust blindly).
5. Only then flip the ruleset fully Active.
6. Add a scheduled canary (hourly is enough) that mints an App installation token and pushes a trivial commit, alerting on failure — the App's credential is now a single point of failure replacing an always-available token; if it's rotated or the installation is suspended, all 18 workflows fail at once with no independent early-warning signal today.

This is still a **one-to-two day engineering cost**, not the multi-session fleet migration the BRO-378 header speculated about — the true exposure (Finding 1) and the identity fan-in (Finding 2) are both far smaller than "~300" suggested — but it's a couple of days, not half a day, once the audit-script step and the ramp are counted in.

## Finding 5: a middle path already exists and may be sufficient on its own

Two lower-cost options short of a full Rulesets PR-required migration:

- **Gate only the highest-risk workflows.** Rulesets can target specific paths/branches but not "some pushes to main, not others" by workflow identity alone — bypass is identity-based, not content-based. So a true subset gate would mean giving only the ~18 files' shared identity bypass and leaving everything else unchanged; there's no partial-gate knob within Rulesets itself. The realistic "middle path" is scope, not mechanism: migrate the ~18 now, leave the other repos' call sites as separate future cards.
- **Merge queue for humans, direct-push for bots** is achievable today with the App/PAT bypass approach: humans go through required PRs (satisfying `required_status_checks` naturally, since the check runs against the PR branch's SHA before merge), the bot identity bypasses entirely — meaning `required_status_checks` in the new ruleset only ever matters for the human PR path, never for the bypassed bot identity (Finding 3's bypass-exempts-all-rules point, made concrete). This is exactly `FULL_ENFORCEMENT_TARGET` plus a bypass list — no separate merge-queue feature needed for this repo's cadence.
- **Do nothing beyond `SAFE_TARGET`** (today's baseline: force-push/deletion protection only) remains a legitimate option — CLAUDE.md's `review-gate.mjs`/pre-push hooks and `infra-plan-review-gate.sh` already function as this repo's real enforcement layer for direct-push infra changes (rule 18, added 2026-08-05). Rulesets would add GitHub-side enforcement against human error/compromised credentials specifically, which the hooks don't cover (hooks live in `~/.claude/` and only fire in a Claude Code session, not on a raw `git push` from any other client).

## Recommendation for the follow-up implementation card

1. Write a small audit script (per-job: what repo does this job's `actions/checkout` target, does a later step in the same job push to that same target) to produce an authoritative "pushes to `thomaspryor/Broadwayscore` main" list mechanically — do not hand-migrate off the ~18 estimate in Finding 1 without this. Estimated ~18 files, confirm exact count and names.
2. Register a GitHub App scoped to `thomaspryor/Broadwayscore` (or repurpose an existing automation identity if one already exists — check org settings first) for CI pushes. Record the App ID in the same declarative target object described in step 5, not left as undocumented UI state (the same failure mode `scripts/setup-branch-protection.js`'s own header was written to prevent for classic protection).
3. Follow the rollout ramp in Finding 4: one canary workflow → Evaluate-mode ruleset → confirm bypass fires live → migrate the rest → flip Active. Explicitly verify in the GitHub UI before any Active apply: the bypass list includes both the App and the human owner/admin identity, and 100% of the target workflow list is confirmed migrated and green.
4. Build the declarative ruleset tooling **before** creating the ruleset by hand, not after (the original draft had this backwards — step 3 creating a hand-applied ruleset, step 4 retroactively scripting it, which is exactly the "changed by hand, remembered only in a doc" anti-pattern `scripts/setup-branch-protection.js`'s header describes as the reason it exists). Extend `scripts/setup-branch-protection.js` rather than fork a new file — a repo-wide grep found this is the *only* declarative diff/dry-run/`--apply` pattern in the codebase, so a second one-off script isn't reuse, it's a fork of a pattern with exactly one prior instance. Extract the shared GET→diff→print→destructive-guard→`--apply`→PUT scaffolding (`ghApiGet`/`ghApiPut`/`diffProtection`/destructive-change refusal, currently all only living inside `setup-branch-protection.js:144-295`) into `scripts/lib/` so classic-protection and rulesets share it structurally rather than by copy-paste.
5. Add a `scripts/lint-workflow-guards.sh` check (an existing, CI-wired "single source of truth for inline guard" mechanism) that flags any new workflow pushing to `main` while still using the bare default `GITHUB_TOKEN` — so a 21st workflow added next quarter can't silently reintroduce the gap this migration closes.
6. Run `/plan-review` on that concrete plan before any live apply — this document's job is to make steps 1–5 estimable, not to approve them.

This document satisfies BRO-424's acceptance criteria (investigation + plan, reviewed via `/plan-review`, no live changes). The implementation is separately scoped follow-up work per the card's own acceptance criteria.

## What changed after review (2026-08-26)

Ran `/plan-review` against the recommendation section (5 of 6 reviewers — Codex via local CLI, three independent Claude agents for structure/pre-mortem/user-impact/design, Gemini unavailable). Two P0s and several P1s came back, all incorporated above:

| Change | Reason | Source |
|---|---|---|
| Corrected Finding 1's workflow list (removed `finance-ingest.yml`, `diagnose-shallow-fetch.yml`; flagged the count as an estimate needing a real audit script) | Both misclassified by a loose grep; Codex verified live against the actual files | Codex |
| Added rollout ramp (1 canary → Evaluate mode → confirm live → migrate rest → Active) | Original plan tested 2-3 workflows but created the ruleset before ALL sites were confirmed migrated — same failure pattern as the BRO-378 outage | Codex, Claude-structure, Pre-mortem |
| Added human/admin identity to the bypass list requirement | Rulesets enforce against admins by default (unlike classic protection); missing this locks out the entire direct-push architecture the instant the ruleset activates | Claude-structure, User-impact |
| Reordered: build declarative tooling before creating the ruleset by hand | Original order repeated the exact "changed by hand, no record" anti-pattern `setup-branch-protection.js` exists to prevent | Claude-structure |
| Resolved extend-vs-new-script question: extend `setup-branch-protection.js`, don't fork | Only one instance of this declarative pattern exists in the codebase; a second file is a fork, not reuse | Code-design |
| Added App credential monitoring canary | New App token is a single point of failure replacing an always-available default token | Pre-mortem, User-impact |
| Added lint-guard follow-up for future workflows | No mechanism currently prevents a 21st workflow from reintroducing the default-`GITHUB_TOKEN` gap | Code-design |
| Noted `regenerate-tier-configs.yml`'s false-green retry bug as a separate follow-up | Pre-existing issue that would make failed pushes during this migration invisible | Codex |

No restructure-the-ramp escalation beyond what's captured above — the ramp finding *is* the restructure, adopted in full rather than dismissed.
