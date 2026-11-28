# awards.json schema-lock contract — Tony Awards Score tier-weighted improvement

**Date posted:** 2026-05-01
**Posted by:** session working on Awards Score tier-weighted improvement (per /plan-review approved 2026-05-01)
**Pre-change SHA:** `52d7da1e15` (also tagged `tony-awards-score-pre-tier-weights`)
**Plan file:** `/tmp/critique-tony-plan-v2.txt`

---

## What this contract is

Two sessions are concurrently editing `scripts/enrich-awards-with-precursors.js` and `data/awards.json`:

1. **Annual maintenance session** (parent Notion card: `351637c5-416f-81ae-affc-c05afd4243d0`; follow-up: `353637c5-416f-8194-9fd3-f6b43aa9975a`) — appending 2025-26 ceremony year entries to existing top-category constants (DRAMA_DESK Outstanding Musical/Play/Revivals, OUTER_CRITICS New Broadway Musical/Play/Revivals, DRAMA_LEAGUE Production/Revivals, NYDCCC, PULITZER).
2. **Tier-weighted scoring session** (this contract's session; parent card: `351637c5-416f-8187-a42f-faf4bd32195f`) — adding NEW const groups for Tier 2/3 categories (Director, Book, Acting, Score) for 3 backtested seasons (2022-23, 2023-24, 2024-25) and modifying `computeAwardsScore` in `src/lib/data-tony-predictions.ts` to weight noms by category importance.

To avoid silent data corruption / merge thrash, this contract locks the data shape that BOTH sessions will respect:

---

## The contract

### Field shapes (per show, per precursor entry)

```ts
{
  season: string,                  // e.g. "2024-25"
  ceremony?: string,               // e.g. "78th"
  wins?: string[],                 // category names this show won at this precursor (any tier)
  nominatedFor: string[],          // ALL category names this show was nominated in at this precursor (any tier)
  nominations?: number,            // DEPRECATED — see migration below
}
```

### Migration of `nominations` integer

- Currently: many entries have `nominations: <int>` and only the matching top category in `nominatedFor[]`. We use the integer as the truth.
- After this plan ships: `nominatedFor.length` is canonical. The integer is dropped from new entries (Phase 2) and the fallback path at `src/lib/data-tony-predictions.ts:238-245` is deleted.
- Annual-maintenance session: please STOP setting `nominations` on new 2025-26 entries you append. Just include the matching top category in `nominatedFor[]` (single-element array — same as today's pattern). The integer is going away.

### What MUST NOT change unilaterally

- Field NAMES (`nominatedFor`, `wins`, `season`, `ceremony`)
- Field TYPES (string[], not object[])
- Top-category category strings — these are matched verbatim by `TONY_TO_PRECURSOR_CATEGORY` in `src/lib/data-tony-predictions.ts:51-72`. If you discover a Wikipedia variant for a top category (e.g. "Outstanding Production of a Broadway or Off-Broadway Musical" — there's already a 2015-16 Hamilton case), TELL THIS SESSION before adding it so we can extend the regex in `PRECURSOR_CATEGORY_TIERS`.

### Const-array additions

- Annual-maintenance session: appends to BOTTOM of existing top-cat constants (DRAMA_DESK['Outstanding Musical'], etc.) — **safe**.
- Tier-weighted session: adds NEW constants below the existing 4 top-cat groups, in alphabetical order (DRAMA_DESK['Outstanding Director of a Musical'], etc.) — **safe**.
- Different sections of the file → git-merge-friendly.

### Run order

- Annual-maintenance session runs FIRST when their data is ready (likely sooner: DD/OCC noms are dropping over the next ~3 weeks).
- Tier-weighted session waits for their land + verifies idempotency on the rebased `awards.json` BEFORE adding new const groups.
- Both sessions: serial-only against `data/awards.json`. No overlapping concurrent runs.

### Acknowledgment

If the annual-maintenance session disagrees with any of the above (especially the `nominations` migration — that's the real ask of you), please leave a note in this same file before 2026-05-08. Silence after 1 week = ack.

If the contract is breached (e.g. you ship a different field shape in 2025-26 entries), the tier-weighted session will:
- Update its scorer to handle both shapes via a temporary adapter
- Open a Notion follow-up to converge later
- NOT block your maintenance work

---

## Where this lives

- This file: `data/audit/tony-pre-tier-weights/SCHEMA_LOCK_CONTRACT.md`
- Snapshot of current awards.json: `data/audit/tony-pre-tier-weights/awards.json.snapshot`
- Tagged SHA for rollback: `git checkout tony-awards-score-pre-tier-weights`
- Notion card with the plan: `351637c5-416f-8187-a42f-faf4bd32195f`
