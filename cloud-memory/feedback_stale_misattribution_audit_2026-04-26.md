---
name: Stale suspectedMisattribution audit (Session 2) — design lessons
description: Per-flag stale audit pattern from the Notion 34e637c5-416f-814c series. 106/106 files cleared in 2 sweeps. /ship-check caught 5 P0+P1 issues in v1; v2 lessons codified below.
type: feedback
originSessionId: 03c98c90-9348-4e87-988a-7c174bfa828a
archived: true
---
**Update 2026-04-26 evening**: Initial sweep was 42 files. After /ship-check
found 5 P0+P1 issues + KNOWN_MULTI_OUTLET_PAIRS allowlist landed in
audit-critic-outlets.js, second sweep cleared the remaining 64. Final: 106/106.


Audit of `suspectedMisattribution=true` flag drift on 2026-04-26 (Notion
34e637c5-416f-81b8). Pattern follows the isRoundupArticle sweep from Session 1
(Notion 34e637c5-416f-817b).

**Findings:**
- Of 106 flagged files, 42 (40%) were stale per the current critic-registry —
  meaning `Guard G` in `scripts/lib/review-file-writer.js` would no longer fire
  on them today. Cleared in commit `387fcd960a1` (broadway-review-texts).
- Of the 42 cleared, only 2 were "meaningful" (substantial fullText +
  isFullReview + valid score). The other 40 were already blocked by
  `wrongProduction` or `contentTier=invalid` — cosmetic clear.
- 64 remained flagged: most are scraper-failure stubs from opening-night
  automation finding wrong-year URLs. 47/47 Cavendish/sunday-telegraph stubs
  also have `wrongProduction=true + contentTier=invalid`.

**Why most "stale" flags don't matter for scoring:**
A flag being "stale by registry" is necessary but not sufficient. To meaningfully
restore scoring, the file must also pass every other guard: not wrongProduction,
not contentTier=invalid/stub, not duplicate, not rejection, etc. Use the
"meaningful sweep targets" filter when reporting impact, not just the raw
stale-by-registry count.

**Sister-publication outlets (sunday-telegraph, sunday-express, times-uk):**
The Guard G flag fires on outletId mismatch, but the URL domain often matches
the critic's primary outlet (e.g. Cavendish/sunday-telegraph URLs are all
telegraph.co.uk). The outlet-disambiguation in `scripts/lib/review-normalization.js`
treats sunday-telegraph as a separate outlet from telegraph despite same domain.
Open question for follow-up: should sister Sunday-edition outlets be aliased
to their daily counterparts, or kept distinct? Aliasing would silence ~50
flagged files but might lose meaningful editorial separation.

**Why the audit-critic-outlets.js skip filter matters:**
`audit-critic-outlets.js` skips `wrongAttribution || wrongProduction || wrongShow`
when computing the registry, so files with those flags don't contribute to
`outletCounts`. This is why a critic with 47 sunday-telegraph files (47 also
wrongProduction) still shows only 2 sunday-telegraph in their `outletCounts` —
the audit ignores most of them. This means the registry NEVER organically
expands knownOutlets for sister-publication outlets if the gathered files
keep getting wrongProduction'd.

**Two-write commit pattern (data + code):**
- Data sweep: `~/broadway-review-texts/` → commit + push there
- Code: worktree → merge to main → push
- DO NOT sweep in the worktree's `data/review-texts` symlink — symlink may not
  point to the right copy (memory `feedback_review_texts_not_symlink.md`).

**Predicate pattern (mirror Guard G's preconditions):**
```js
function isLikelyStaleSuspectedMisattribution(data, registry) {
  // ...
  const entry = registry[slug];
  if (!entry) return true;                            // Guard G short-circuits
  if (entry.isFreelancer === true) return true;       // Guard G skips
  if (knownOutlets.length === 0) return true;         // Guard G's length check
  if (knownOutlets.includes(outletId)) return true;   // Guard G passes
  return false;
}
```
The principle: stale predicate is the inverse of the SETTER's preconditions.
Each exclusion-flag setter has different preconditions, so each stale-clear
predicate is different. Don't try to generalize across flags — Session 1
(roundup) used URL whitelist, this Session 2 used registry mirror, future
sessions for `isNonReview`/`crossOutletDuplicate`/etc. will need their own
custom mirrors.

---

## Ship-check P0+P1 lessons (5 issues caught by Codex + Claude reviewers)

The initial v1 predicate had subtle bugs that two-reviewer adversarial
review caught before they shipped damage. Codify these for future stale-flag
predicates:

**1. SLUGIFIER MUST MATCH THE SETTER, NOT BE A NEW COPY (P0)**
The setter (`Guard G` in `review-file-writer.js:261-281`) calls
`normalizeCritic()` which strips honorific prefixes (`MR.`/`MS.`/`DR.`/`CSA.`)
and applies `CRITIC_ALIASES`. The v1 predicate raw-slugified, so a file with
`"MR. Ben Brantley"` would slug to `mr-ben-brantley`, miss the registry
entry, and silently un-flag a real misattribution. Three places in the
codebase have copies of similar slug logic:
- `audit-critic-outlets.js:60-65` (its own copy — independent of writer)
- raw `name.toLowerCase().replace(/[^a-z0-9]+/g,'-')` (used in v1 predicate)
- `normalizeCritic()` in `review-normalization.js:373` (the canonical one)
Predicates that look up the registry MUST use the same normalizer the
writer/registry-builder uses. Don't write new copies.

**2. EMPTY-REGISTRY MASS-CLEAR FAIL-SAFE (P0)**
`getCriticRegistry()` returned `{}` silently on read error. Combined with
the predicate returning `true` when `entry === undefined`, an empty
registry silently un-flagged EVERY flagged file across all 4 gate sites
— the inverse of the bug we were fixing. Fix: predicate treats empty
registry as "cannot prove staleness" (returns false everywhere) AND the
loader logs a warning once. Same pattern applies to any predicate that
reads a data file at decision time.

**3. OUTLET ALIAS MISMATCH (P1)**
`audit-critic-outlets.js:123` writes `normalizeOutlet(outletId)` into
`knownOutlets`. The v1 predicate compared raw `data.outletId`, so
pre-canonical outletIds on files would fail the `includes()` check even
when the registry "knew" about that outlet under canonical form. Fix:
predicate canonicalizes via `normalizeOutlet` before comparing (also
keeps raw check as fallback for legacy registry rows).

**4. SCORING-DELTA MUST HASH DATA, NOT JUST FUNCTION SOURCE (P1)**
`scoring-delta.js guardsIdentical` only compared function source. Predicate
decisions depend on `critic-registry.json` content — same source + different
registry → different decisions. Fix: hash the data file content (working
tree + git baseline) and include in the identity check. Same gotcha will
apply to any future predicate that reads data files at decision time.

**5. UPSTREAM CHURN — SWEEP ALONE DOESN'T FIX SETTER (P1)**
Guard G kept re-flagging Cavendish/sunday-telegraph etc. on every new
gather because `audit-critic-outlets.js` skips wrongProduction files
(line 94) — so the data-driven knownOutlets never expanded for sister
publications. The 42-file v1 sweep was one-shot but the source was
unfixed. Fix: `KNOWN_MULTI_OUTLET_PAIRS` allowlist in
`audit-critic-outlets.js` (similar to existing `KNOWN_FREELANCERS` list)
that durably unions sister-publication outletIds into knownOutlets each
regeneration. After expansion, all 64 previously-confirmed flags became
stale-by-registry and were cleared in the second sweep.

**Operational lesson**: a stale-flag sweep is incomplete unless you also
either (a) fix the setter to not re-fire, or (b) document why the source
is acceptable (e.g. closed-show only). Otherwise the next gather pollutes
the corpus again.

---

## Wrong-production stub GC (companion cleanup)

Same session also built `scripts/gc-wrong-production-stubs.js` to clean up
4824 empty stubs (wrongProduction + contentTier=invalid + empty fullText)
created by opening-night URL-discovery failures. Closed-show filter only
(open-show stubs would re-pollute because review-file-writer.js merges
into existing files but creates new ones when missing — deleting an
active-show stub triggers re-creation). 276 closed-show stubs deleted in
`e1249d2c754`.

Real fix for the open-show case: URL-history blocklist in gather-reviews
(track URLs known to be wrong-production, skip on next discovery). Left
as a future improvement.
