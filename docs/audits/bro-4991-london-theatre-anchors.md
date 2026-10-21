# BRO-4991: London Theatre anchor verification

Local corpus audit on 2026-10-21. No review text or private review files were changed.

Run `node scripts/check-score-integrity.js`. Its existing weekly-integrity caller now writes
`londonTheatreAnchors` into `data/audit/score-integrity.json`, before skipping null or cleared
original scores. The report contains every confirmed row and two advisory worklists:
`reanchorQueue` for verified-star mismatches and `ratingVerificationQueue` for missing or
unverified critic ratings. These lists do not automatically schedule scoring or write private data.

## Current results

- 58,321 files scanned; 184 London Theatre `anchored-v6` rows.
- 146 bands and scores confirmed against page-verified critic ratings; 0 known mismatches.
- 38 rows still need primary-source rating verification, listed below. Their old bands are
  context only; they do not establish the critic rating. Re-anchoring cannot safely proceed
  from the stored relay or the old band.
- This inventory includes excluded rows: 16 of the 38 unverified rows and 12 of the 146
  confirmed rows have `wrongProduction: true`. Band confirmation does not establish
  production eligibility. Respect existing exclusions before any rescoring; these rows
  must not be rescored unless their production match is separately corrected.
- The Noises Off placeholders are already replaced on main: Marianka Swain has `4/5 stars`
  and Mark Shenton has `5/5 stars`, both sourced from `londontheatre-page-json`.
- Integrity totals before and after: 0 aggregator scores in P0, 0 no-star outlet scores,
  and 176 aggregator-source rows without scoreSource (below 203; 0 from London Theatre).
- Before this change, the integrity report had no anchor worklist. After: 146 confirmed,
  0 to re-anchor, 38 requiring verification. Rating, band, score, and source changes: 0.

Examples confirmed by the canonical band detector: A Christmas Carol (2022), Matt Wolf,
`4/5 stars`, band 71-90, score 82; A Life in Four Seasons (2026), Aliya Al-Hassan,
`3/5 stars`, band 51-70, score 66; Inside No. 9 (2025), Anya Ryan, page-verified normalized
60, band 51-70, score 65. The last case exercises legacy numeric storage.

## Outstanding primary-source verification

All paths are relative to `data/review-texts/`. Each row currently has no active verified
critic rating. This read-only checkout cannot update the private review-texts repo.
Verify the outlet page, then store the critic rating and use the existing late-star
re-anchoring path if the verified band differs. If the critic never rated the review,
it needs an unanchored rescore rather than a rating inferred from an aggregator.

| Review file | Old anchor band | Stored score |
| --- | --- | --- |
| `4-48-psychosis-west-end-2025/london-theatre--holly-omahony.json` | 71-90 | 79 |
| `a-night-with-janis-joplin-2013/london-theatre--matt-wolf.json` | 51-70 | 65 |
| `abba-voyage-off-west-end-2026/london-theatre--sophie-thomas.json` | 91-100 | 97 |
| `abba-voyage-off-west-end-2026/london-theatre--unknown.json` | 91-100 | 96 |
| `bengal-tiger-at-the-baghdad-zoo-2011/london-theatre--matt-wolf.json` | 71-90 | 80 |
| `black-is-the-color-of-my-voice-west-end-2026/london-theatre--unknown.json` | 71-90 | 82 |
| `bleak-expectations-west-end-2023/london-theatre--matt-wolf.json` | 31-50 | 37 |
| `cabaret-at-the-kit-kat-club-west-end-2021/london-theatre--chris-omaweng.json` | 71-90 | 83 |
| `cabaret-at-the-kit-kat-club-west-end-2021/london-theatre--unknown.json` | 71-90 | 84 |
| `clybourne-park-2012/london-theatre--matt-wolf.json` | 71-90 | 79 |
| `coming-clean-west-end-2020/london-theatre--mark-shenton.json` | 71-90 | 79 |
| `cuckoo-west-end-2023/london-theatre--matt-wolf.json` | 71-90 | 82 |
| `dancing-at-lughnasa-west-end-2023/london-theatre--marianka-swain.json` | 91-100 | 96 |
| `dr-semmelweis-west-end-2023/london-theatre--marianka-swain.json` | 71-90 | 89 |
| `dr-strangelove-west-end-2024/london-theatre--marianka-swain.json` | 71-90 | 89 |
| `giant-west-end-2025/london-theatre--julia-rank.json` | 51-70 | 54 |
| `hadestown-west-end-2024/london-theatre--will-longman.json` | 51-70 | 68 |
| `high-society-west-end-2026/london-theatre--marianka-swain.json` | 71-90 | 87 |
| `kimberly-akimbo-off-west-end-2026/london-theatre--marianka-swain.json` | 71-90 | 81 |
| `machinal-2014/london-theatre--olivia-rook.json` | 71-90 | 80 |
| `mad-house-west-end-2022/london-theatre--sophie-thomas.json` | 91-100 | 96 |
| `magic-mike-live-west-end-2021/london-theatre--unknown.json` | 71-90 | 71 |
| `medea-west-end-2023/london-theatre--marianka-swain.json` | 71-90 | 82 |
| `my-neighbour-totoro-west-end-2025/london-theatre--unknown.json` | 91-100 | 99 |
| `oleanna-2009/london-theatre--matt-wolf.json` | 51-70 | 61 |
| `passing-strange-2008/london-theatre--marianka-swain.json` | 71-90 | 81 |
| `punch-west-end-2025/london-theatre--anya-ryan.json` | 71-90 | 85 |
| `rock-n-roll-2007/london-theatre--matt-wolf.json` | 71-90 | 76 |
| `the-brightening-air-west-end-2025/london-theatre--unknown.json` | 51-70 | 66 |
| `the-drifters-girl-west-end-2021/london-theatre--marianka-swain.json` | 51-70 | 64 |
| `the-estate-west-end-2025/london-theatre--theo-bosanquet.json` | 71-90 | 81 |
| `the-great-british-bake-off-musical-west-end-2023/london-theatre--marianka-swain.json` | 71-90 | 81 |
| `the-hunger-games-on-stage-west-end-2025/london-theatre--marianka-swain.json` | 31-50 | 36 |
| `the-other-place-west-end-2024/london-theatre--holly-omahony.json` | 51-70 | 66 |
| `the-phantom-of-the-opera-west-end-1986/london-theatre--julia-rank.json` | 71-90 | 87 |
| `the-phantom-of-the-opera-west-end-1986/london-theatre--theo-bosanquet.json` | 71-90 | 87 |
| `the-prince-of-egypt-west-end-2020/london-theatre--mark-shenton.json` | 31-50 | 32 |
| `the-producers-west-end-2025/london-theatre--unknown.json` | 51-70 | 69 |

## Wiring and cost

`scripts/llm-scoring/ensemble-scorer.ts` writes `scoreSource: anchored-v6` and
`llmScore.band`. The audit reads that output and derives the comparison band from the
verified originalScore alone via `detectBandFromReviewFile`, excluding relayed fields.
`scripts/check-score-integrity.js` calls the helper; `.github/workflows/weekly-integrity.yml`
already calls the integrity script on Sundays at 03:00 UTC. No workflow changes.
Additional paid fetches, LLM calls, and API calls per run: 0.
