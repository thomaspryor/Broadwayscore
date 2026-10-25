# Titanique opening night post-mortem (BRO-864)

Opening night: 2026-04-12. Post-mortem written up in Notion the next day
(2026-04-13), migrated to Linear as BRO-864. This doc reconstructs the record
from the migrated card text — the original session's fuller writeup
(`~/Documents/claude-outputs/titanique-opening-night-postmortem.md`) and
workaround notes (`memory/opening_night_workarounds.md`) were local-only
artifacts on the operator's machine and never made it into git, so they
aren't recoverable from this repo. What follows is the punch list from the
card plus a 2026-09-15 status check against the current codebase — five
months on, most of it has since landed as real fixes, several with git
history that references this exact incident.

**Headline numbers:** 35 issues found, 7 fixed live during the event,
21 reviews collected in **3 hours** against a **30-minute** target.

---

## Status legend

- **RESOLVED** — code/workflow exists now and its shape matches the ask.
- **PARTIAL** — related infra exists but doesn't fully cover the ask.
- **OPEN** — no evidence found; still a gap as of 2026-09-15.

## P0 — The loop + discovery

1. **Single opening-night workflow (collect→score→rebuild→deploy), own
   concurrency group.** RESOLVED. `.github/workflows/opening-night-express.yml`
   exists, alongside a dedicated retry-check workflow
   (`opening-night-express-retry-check.yml`).
2. **BWW RR auto-discovery — scrape the BWW show page for the roundup
   link.** RESOLVED. `scripts/lib/bww-rr-discover.js`, backed by a broader
   reverse-discovery family (`reverse-discovery.js`,
   `reverse-discovery-backlog.js`) and `scripts/discover-regional-serp-reviews.js`.
3. **Cancel-and-deploy script — automate the manual workaround.** OPEN.
   No `cancel-and-deploy`/`cancel-cascade` script found. Adjacent tooling
   exists (`scripts/check-prod-deploy.js`, `scripts/lib/ci-cancellation-guard.js`,
   `scripts/audit-deployed-coverage.js`) but nothing that automates the
   specific cancel-then-redeploy sequence this item describes.

## P1 — Data quality

4. **DTLI `/shows/` URL prefix + Playwright extraction (JS-rendered).**
   RESOLVED. `scripts/lib/dtli-homepage-scan.js` scans the `/shows/{slug}/`
   pattern; `scripts/extract-dtli-reviews.js` and `scripts/scrape-dtli.js`
   handle extraction; `discover-dtli-slugs.js` builds the slug index.
5. **OB/WE transfer metadata reset — clear ALL stale flags
   (wrongProd+contentTier+incompleteReason+publishDate) when the URL
   changes production.** RESOLVED. `scripts/lib/restore-protected-fields.js`
   has a `_urlChangedClear` breadcrumb mechanism specifically for this: an
   intentional clear behind a URL change is recognized and not re-populated
   from stale local state (see the `isIntentionalClear` logic around line 295).
6. **restore-protected-fields text overwrite guard — never overwrite
   fullText with shorter/empty.** RESOLVED. The same file compares
   `oursText.length` against local `fullText.length` and only restores when
   ours is both non-trivial (>100 chars) and longer, explicitly to stop "a
   push rebase re-applying old empty fullText over newly collected 5000+
   char" text (comment at line ~287).
7. **Triple-block clearing — wrongProd alone isn't enough, must clear 5+
   fields.** RESOLVED. `restore-protected-fields.js` carries a manual-clear
   field set including `wrongProductionManualClear`, `wrongProductionOverride`,
   `wrongProductionOverrideReason`, `wrongProductionOverrideSetAt`,
   `wrongProductionOverrideSetBy`, plus the `wrongProduction` flag itself.

## P2 — Scoring + extraction

8. **LLM conclusion weighting** (Notion card `341637c5-416f-8191-8547-d72f2d9e3373`).
   Not independently verifiable from this repo — no Linear/Notion cross-ref
   survived the migration for this sub-item. Treat as unverified rather than
   resolved; file a fresh Linear issue if this is still wanted and no longer
   tracked.
9. **Guardian API star extraction (not HTML).** PARTIAL. Guardian handling
   exists in `scripts/lib/score-extractors.js`, but nothing in this repo
   confirms it calls the Guardian's Open Platform API rather than parsing
   HTML — worth a direct read of that extractor before assuming this shipped
   as specified.
10. **BWW thumb extraction (new image format).** RESOLVED.
    `scripts/backfill-bww-thumbs.js` and `scripts/enrich-bww-thumbs.js` both
    exist.
11. **NYSR star swap fix (match to specific URL).** Not directly
    confirmed — no `NYSR`/`nysr`-named extractor file found; likely folded
    into a shared outlet handler. Unverified.
12. **Scorer rejection logging (explain WHY 0 valid files).** RESOLVED.
    `scripts/test-scoring-rejection-logs.js` exists as a dedicated test for
    this exact behavior.
13. **DTLI per-card thumb extraction.** OPEN. No DTLI-specific thumb
    extractor found (contrast with the BWW thumb scripts in #10).

## P3 — Friction

14. **Notion hook blocking (`rm /tmp/notion-create-failed`).** RESOLVED,
    and superseded — Notion card creation is now blocked outright by
    `.claude/hooks/notion-create-block.sh` per CLAUDE.md rule 6 (Linear is
    the board now, not Notion).
15. **Duplicate `--unknown` files from the poller.** RESOLVED, and the fix
    literally cites this incident: `scripts/opening-night-poller.js:1356-1389`
    skips creating a new `outlet--unknown.json` when a named-critic file for
    the same outlet and URL already exists, with the comment *"Titanique
    postmortem: amny--unknown.json, chicagotribune--unknown.json alongside
    named files"*.
16. **Data repo merge conflict handling.** RESOLVED. `scripts/setup-local-data.sh`
    now registers a `merge.ours` git driver for audit-state conflicts (visible
    in this session's own bootstrap log), plus `scripts/lib/reconcile-merged-json.js`
    for reconciling merged JSON more generally.
17. **DTLI calibration > BWW for borderline reviews.** Not verifiable as a
    discrete change from static analysis — this is a scoring-weight/calibration
    call, not a named function or file. Unverified; would need a scoring-delta
    comparison against a DTLI/BWW-disagreement fixture to confirm it's live.

---

## Summary as of 2026-09-15

| Priority | Resolved | Partial | Open/Unverified |
|---|---|---|---|
| P0 (3 items) | 2 | 0 | 1 (#3 cancel-and-deploy) |
| P1 (4 items) | 4 | 0 | 0 |
| P2 (6 items) | 2 | 1 | 3 (#8, #11, #13, #17 — one is genuinely open, three are unverified) |
| P3 (4 items) | 4 | 0 | 0 |

The loop-and-discovery and data-quality tiers (P0/P1) are effectively closed
out — five months of subsequent commits addressed nearly all of them, several
explicitly referencing this incident in code comments. The remaining gaps are
concentrated in P2: a standalone cancel-and-deploy automation script (P0-3)
and DTLI per-card thumbnails (P2-13) are genuinely open with no trace in the
codebase; Guardian API-vs-HTML extraction (P2-9), the NYSR star-swap fix
(P2-11), and DTLI/BWW calibration weighting (P2-17) could not be confirmed
one way or the other from static repo analysis and would need a direct code
read or a scoring-delta run to close out.

If any of the open/unverified items above are still wanted, file them as
fresh, independently-trackable Linear issues rather than reopening this one —
BRO-864 itself is closed by the existence of this document per its
acceptance criteria.
