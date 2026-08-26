# BRO-424 — GitHub Rulesets investigation

**Status: INVESTIGATION ONLY. No live branch-protection changes made or proposed for immediate application.** This document is the deliverable for BRO-424 (deferred by the owner 2026-08-18, tracked as backlog). A future session must run `/plan-review` against the plan section below before touching live rulesets.

## Why this exists

BRO-378 found that classic branch protection's `required_status_checks` rejects any direct push of a fresh commit outright (`GH006: Required status check "Lint Workflows" is expected`), independent of `enforce_admins` or the pushing identity — confirmed live against a real production workflow (Update Deploy Watermark, run 32087193625), reverted within 3 minutes. See `scripts/setup-branch-protection.js` header and `memory/feedback_branch_protection_direct_push.md` for the full incident. Both concluded that real enforcement requires migrating direct-push workflows off `git push origin main`, with "GitHub Rulesets with a bypass-actor list" named as the likely mechanism but left untested. This card tests that claim.

## Finding 1: the "~300 workflows" figure overstates this repo's actual exposure

The BRO-378 header cites "~300 direct-push-to-main workflows" as the migration surface. That figure is **not the count of workflows pushing to Broadwayscore's own `main`** — it's inflated by cross-repo pushes to the private data repos (`broadway-scorecard-data`, review-texts, aggregator-archive), which are separate GitHub repos with their own independent branch protection and are out of scope for a ruleset on `thomaspryor/Broadwayscore` (the repo `scripts/setup-branch-protection.js` actually targets, `DEFAULT_REPO`).

Verified counts (2026-08-26, via grep across `.github/workflows/*.yml`):

| Category | Count |
|---|---|
| Workflow files calling `scripts/lib/push-with-retry.sh` (any repo) | 154 |
| ...of which check out and push to **this repo's own main** (no `checkout-core-data`/`checkout-review-texts`/`checkout-aggregator-archive` composite) | 19 |
| Additional files with a custom inline `git push origin main` retry loop instead of `push-with-retry.sh` (`audit-aggregator-gap.yml`, `finance-ingest.yml`, `scrape-dtli-show-score.yml`, `regenerate-tier-configs.yml`) | 4 |
| **Total workflows that direct-push to `thomaspryor/Broadwayscore` main** | **~20 (some overlap possible; not a hard dedupe)** |
| Excluded: `mirror-to-gitlab.yml`, `mirror-data-to-gitlab.yml`, `mirror-review-texts-to-gitlab.yml` — push to `gitlab.com`, not GitHub | 3 |
| Excluded: `purge-archives-history.yml` — force-pushes arbitrary archive/tag refs via `--force-with-lease`, rarely `main`, already blocked today by `allow_force_pushes: false` regardless of any ruleset decision | 1 |

The full list of the ~20:
`brand-mention-monitor.yml`, `check-cron-health.yml`, `check-cwv-health.yml`, `check-flag-parity.yml`, `check-push-ledger.yml`, `daily-digest.yml`, `diagnose-shallow-fetch.yml`, `diag-fetch-timing.yml`, `guard-no-orphan-commit.yml`, `monitor-scheduled-email-count.yml`, `monitor-gate-ab.yml`, `stage-latency-rotation.yml`, `test-ugc-roundtrip.yml`, `ux-walkthrough.yml`, `weekly-nyt-critics-picks.yml`, `finance-ingest.yml`, `scrape-dtli-show-score.yml`, `regenerate-tier-configs.yml`, `audit-aggregator-gap.yml`.

This matters for cost: the migration surface for *this* card is **~20 workflow files**, not 300. The other ~285 push-with-retry.sh call sites target other repos and are each that repo's own future card, not this one.

## Finding 2: all ~20 push as the default `GITHUB_TOKEN` — one identity, not twenty

Checked every workflow in the list above for its checkout/push token: all 20 use the implicit default `GITHUB_TOKEN` (a few pass it explicitly as `secrets.GITHUB_TOKEN`, most rely on `actions/checkout@v5`'s default). None use a custom PAT for pushing to this repo's own main (`REVIEW_TEXTS_TOKEN` and friends are for the *other* repos). Where they set a commit identity at all, it's `github-actions[bot]` / `github-actions[bot]@users.noreply.github.com`.

This means the bypass surface is conceptually **one identity**, not twenty separate migrations — good news for cost, bad news for the mechanism (see Finding 3).

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

1. **One-time setup (not per-workflow):** register a GitHub App (or designate a machine-user PAT) for `thomaspryor/Broadwayscore`, store its credential as an org/repo secret, add it to the new ruleset's bypass list (`bypass_mode: always`, so it also covers non-PR direct pushes, not just PR merges).
2. **Per-workflow change, ~20 files:** in each of the 19 `push-with-retry.sh` callers + 4 inline-loop pushers listed in Finding 1, swap the implicit `GITHUB_TOKEN` (used for both `actions/checkout` and the later push) for the new App/PAT token. This is a mechanical, identical edit at each site — realistically a single small PR touching ~20 `uses: actions/checkout@v5` / `token:` lines, not 20 independent design decisions. Rough estimate: half a day including testing 2–3 representative workflows live (per CLAUDE.md's "test 3 representative cases" rule for infra changes), not a multi-week fleet migration.
3. **Then, and only then,** flip `scripts/setup-branch-protection.js`'s target from `SAFE_TARGET` to a new Rulesets-based `FULL_ENFORCEMENT_TARGET` with `required_pull_request_reviews` for humans and the bot identity on the bypass list.

This is a **half-day to one-day engineering cost**, not the multi-session fleet migration the BRO-378 header speculated about — because the true exposure (Finding 1) and the identity fan-in (Finding 2) are both far smaller than "~300" suggested.

## Finding 5: a middle path already exists and may be sufficient on its own

Two lower-cost options short of a full Rulesets PR-required migration:

- **Gate only the highest-risk workflows.** Rulesets can target specific paths/branches but not "some pushes to main, not others" by workflow identity alone — bypass is identity-based, not content-based. So a true subset gate would mean giving only the ~20 files' shared identity bypass and leaving everything else unchanged; there's no partial-gate knob within Rulesets itself. The realistic "middle path" is scope, not mechanism: migrate the ~20 now, leave the other ~285 (different repos) as separate future cards.
- **Merge queue for humans, direct-push for bots** is achievable today with the App/PAT bypass approach: humans go through required PRs (satisfying `required_status_checks` naturally, since the check runs against the PR branch's SHA before merge), the bot identity bypasses entirely. This is exactly `FULL_ENFORCEMENT_TARGET` plus a bypass list — no separate merge-queue feature needed for this repo's cadence (~20 bot pushes vs. human PRs are already infrequent enough that GitHub's native "no two required reviews can merge simultaneously" behavior is not a bottleneck here).
- **Do nothing beyond `SAFE_TARGET`** (today's baseline: force-push/deletion protection only) remains a legitimate option — CLAUDE.md's `review-gate.mjs`/pre-push hooks and `infra-plan-review-gate.sh` already function as this repo's real enforcement layer for direct-push infra changes (rule 18, added 2026-08-05). Rulesets would add GitHub-side enforcement against human error/compromised credentials specifically, which the hooks don't cover (hooks live in `~/.claude/` and only fire in a Claude Code session, not on a raw `git push` from any other client).

## Recommendation for the follow-up implementation card

1. Register a GitHub App scoped to `thomaspryor/Broadwayscore` (or repurpose an existing automation identity if one already exists — check org settings first) for CI pushes.
2. Migrate the ~20 workflows in Finding 1 to use that App's installation token instead of the default `GITHUB_TOKEN`, testing 2–3 live (`check-cron-health.yml`, `daily-digest.yml`, and one force-push-adjacent case) per CLAUDE.md's infra-change rule.
3. Create a new ruleset (not classic protection) on `main` with `required_pull_request_reviews` for humans, `required_status_checks: ['Lint Workflows']`, and the new App on the bypass list with `bypass_mode: always`.
4. Update `scripts/setup-branch-protection.js` (or a new `scripts/setup-rulesets.js`, since Rulesets is a distinct API from classic branch protection — `PUT /repos/{owner}/{repo}/rulesets/{id}` vs `PUT /repos/{owner}/{repo}/branches/{branch}/protection`) to make the new ruleset state declarative, mirroring the existing diff/dry-run/`--apply` pattern.
5. Run `/plan-review` on that concrete plan before any live apply — this document's job is to make step 3–4 estimable, not to approve them.

This document satisfies BRO-424's acceptance criteria (investigation + plan, no live changes). The implementation is separately scoped follow-up work per the card's own acceptance criteria.
