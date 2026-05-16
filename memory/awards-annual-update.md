# Annual Awards Data Update — Operator Runbook

Run once per year, ideally late June / early July after the Tony ceremony, to capture all major US ceremonies. Olivier (UK) is offset; do that one in late February/March.

**Estimated time:** ~1 hour for all 6 ceremonies. **Cost:** $0 (manual entry from Wikipedia + official sources).

---

## Why this exists

Five of the six precursor ceremonies (DD, OCC, DL, NYDCC, Pulitzer) are appended to inline JS constants in `scripts/enrich-awards-with-precursors.js`. Tony has its own scraper. Olivier has `scripts/enrich-olivier-awards.js`. There is no automated pipeline for the inline-constant ceremonies — by design, because (a) the volume is tiny (~25 keys/year), (b) hand-curated data is git-diffable and resists source-website changes, (c) the historic backfill (`HISTORIC_PULITZER`) uses the same direct-by-id pattern and works perfectly.

Two safety nets back this runbook:
1. **CI freshness gate** in `.github/workflows/test.yml` (`awards-data-freshness` job): fails daily if `data/awards.json` hasn't changed in 14 months. Surfaces in the daily email digest if it fires.
2. **Cron health check** in `.github/workflows/check-cron-health.yml`: alerts within ~1 week if `update-tony-awards.yml` (weekly Monday cron) stops running.

---

## When new data drops

| Ceremony | Noms announced | Winners announced | Source |
|---|---|---|---|
| Tony (US) | late April / early May | mid-June (2nd Sun) | Automated via `update-tony-awards.yml` |
| Pulitzer Drama (US) | n/a (winner only) | mid-late April | Manual |
| Drama Desk (US) | late April | early June | Manual |
| Outer Critics (US) | late April | mid-late May | Manual |
| Drama League (US) | early-mid April | mid-May | Manual |
| NY Drama Critics (US) | n/a (winner only) | first week of May | Manual |
| Olivier (UK) | mid-late February | early-mid April | Manual via `enrich-olivier-awards.js` |

Tony updates flow automatically. The other 6 are appended manually using the steps below.

---

## Manual update steps

### 1. Open `scripts/enrich-awards-with-precursors.js`

Five constants to potentially append per year (find the `// 2026` or latest entry per category):

| Constant | Categories | Format |
|---|---|---|
| `DRAMA_DESK` | 4 (Outstanding Musical, Outstanding Play, Outstanding Revival of a Musical, Outstanding Revival of a Play) | `{ year, winner, nominees: [...] }` |
| `OUTER_CRITICS` | 8 (Outstanding New Broadway Musical, Outstanding New Broadway Play, etc.) | same |
| `DRAMA_LEAGUE` | 3 (Outstanding Production of a Musical / Play / Revival of a Play) | same |
| `NYDCCC` | 3 (Best Play, Best Foreign Play, Best Musical) | `{ year, winner }` — winners only |
| `PULITZER` | 1 (Drama) | `{ year, winner, finalists: [...] }` — finalists exclude winner |

**Important formatting rules** (matches existing entries):
- `nominees` MUST include the winner
- `finalists` (Pulitzer) MUST EXCLUDE the winner
- If a year was not awarded, omit it and leave a `// YYYY not awarded` comment
- Off-Broadway-only entries can be included; the matcher will skip them cleanly
- Use exact title from Wikipedia (the matcher handles the title-normalization)

### 2. Sources

For each ceremony, the canonical Wikipedia URL is:
- Drama Desk: `https://en.wikipedia.org/wiki/N{th,st,rd}_Drama_Desk_Awards`
- Outer Critics: `https://en.wikipedia.org/wiki/N{th,st,rd}_Outer_Critics_Circle_Awards`
- Drama League: `https://en.wikipedia.org/wiki/N{th,st,rd}_Drama_League_Awards`
- NYDCC: `https://en.wikipedia.org/wiki/YYYY-YY_New_York_Drama_Critics%27_Circle_Awards`
- Pulitzer: `https://www.pulitzer.org/prize-winners-by-year/YYYY` (official; cross-check with Wikipedia)

Wikipedia is usually updated within hours of announcement. Official Pulitzer site is authoritative for that one.

### 3. Verify before committing

```bash
# 1. Stub shows.json if you don't have the private repo synced
[ -f data/shows.json ] || echo "[]" > data/shows.json

# 2. Run enrichment
node scripts/enrich-awards-with-precursors.js

# 3. Sanity-check key shows
npx tsx scripts/sanity-check-awards-scoring.ts

# 4. Full corpus audit
npx tsx scripts/audit-award-scores.ts
```

Confirm in the output:
- `Idempotency assertion passed (Pulitzer migrate-stable: true)` — script ran clean
- `Pulitzer Drama: N matched, M unmatched` — most unmatched are OB shows, that's normal
- `Pulitzer (historic): 38 matched, 0 missing showIds` — historic table is intact (no regression)
- New ceremony's winners show up in `audit-award-scores.ts` with sensible scores (not 0)

### 4. Commit + push

```bash
rm -f data/shows.json   # remove stub if you created one
git add data/awards.json scripts/enrich-awards-with-precursors.js
git commit -m "data: Annual awards update YYYY (DD / OCC / DL / NYDCC / Pulitzer)"
git push
```

If something looks wrong: `git revert HEAD` and try again.

---

## Edge cases

- **Tied winners.** Drama Desk has had ties; Pulitzer has not. The current schema treats `winner` as a single string. If a tie occurs, file an issue and pick one for now (the schema needs `winners: string[]` to fix properly, which cascades to `src/lib/awards-scoring.ts`).
- **No-award years.** Pulitzer skipped 2021 (COVID), 1986, 1997. Add a comment `// YYYY not awarded` and skip the entry.
- **Postponed ceremonies.** Tonys were September 2021 due to COVID. Doesn't affect data structure — just append normally with the actual year.
- **Special / honorary awards.** Tony Lifetime Achievement, Pulitzer Special Citations, Drama League Founders Award — these don't fit the schema and aren't displayed on the Awards Scorecard. Skip them.
- **OB-only winners.** Many Pulitzer Drama winners (and DD finalists) are Off-Broadway. Append the entry anyway; the matcher in `findShowIdByTitle` will skip cleanly. If an OB show later transfers to Broadway, the existing `HISTORIC_PULITZER`-style direct-by-id pattern can attribute the past prize to the new entry — see `memory/awards-historical-backfill.md` for the precedent.
- **Retroactive corrections.** Pulitzer occasionally adjusts historical attributions. If the source data changes for a prior year, edit the existing entry in place, re-run enrichment, and verify the score-delta in `audit-award-scores.ts` is small and intentional.

---

## What NOT to do

- ❌ Build an LLM-powered auto-ingestion pipeline. Considered + rejected (see Notion card on awards-pipeline-design 2026-05-15) — too much engineering for ~1 hour/year of operator work, and the LLM-based title-matching reintroduces fragility that the historic backfill's direct-by-id pattern explicitly removed.
- ❌ Use the fuzzy matcher (`findShowIdByTitle`) for historic backfill. It's gated by `PREDICTIONS_ERA` and unsafe for pre-2014 revival-collision territory. Add to `HISTORIC_PULITZER` instead.
- ❌ Edit `data/awards.json` directly. Always edit the constants and re-run the enrichment script — that's what makes it idempotent and reviewable.

---

## Key files

- `scripts/enrich-awards-with-precursors.js` — source-of-truth constants + applier
- `scripts/sanity-check-awards-scoring.ts` — canonical test cases (Hamilton, Next to Normal, etc.)
- `scripts/audit-award-scores.ts` — full-corpus distribution audit
- `data/awards.json` — derived output (committed, deployed)
- `src/lib/awards-scoring.ts` — read-only consumer; the prestige-weighted Awards Score formula
- `.github/workflows/update-tony-awards.yml` — automated Tony scraper (weekly cron + manual)
- `.github/workflows/test.yml` (`awards-data-freshness` job) — 14-month staleness gate
- `.github/workflows/check-cron-health.yml` (Tony entry) — weekly cron health check
