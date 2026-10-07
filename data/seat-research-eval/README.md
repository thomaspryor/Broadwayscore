# Seat-research eval harness

Lightweight harness for measuring and iterating on the seat-research prompt used to populate theater-metadata.json with section-level verdicts (see SeatingGuidance component).

## Why this exists

First research pass on Majestic + Music Box shipped with fabricated claims (seat numbers, row-specific geometric facts, misattributions to sources). `scripts/adjudicate-seat-research.js` catches these post-hoc, but we need a way to **iterate the research prompt** and measure whether changes reduce fabrication before we scale from 2 → 40 theaters.

This harness is not a full evaluation framework. It's:
- A **fixed test set** (`test-set.json`) of 5 theaters with mixed difficulty.
- A **versioned prompt directory** (`prompts/v1.md`, `prompts/v2.md`, …).
- An **aggregator** (`scripts/eval-seat-research.js`) that collapses per-theater adjudicator output into one composite score + append-only history.

## Workflow

### Step 1: Run research against the test set (manual, via subagents)

For each theater in `test-set.json`, dispatch a research subagent using the current prompt version (e.g. `prompts/v1.md`). Each subagent writes `/tmp/{slug}-research.json`.

Parallel dispatch is safe — each theater writes to its own scratch file. `node scripts/adjudicate-seat-research.js` is the next step.

### Step 2: Run the adjudicator on each research output

```bash
node scripts/adjudicate-seat-research.js /tmp/majestic-research.json
node scripts/adjudicate-seat-research.js /tmp/music-box-research.json
# … etc for each theater
```

Each run produces `/tmp/{slug}-research-audit.json`.

### Step 3: Aggregate and score

```bash
node scripts/eval-seat-research.js \
  --prompt-version=v1 \
  --audits-dir /tmp
```

The aggregator:
- Reads all `*-research-audit.json` files
- Collapses into totals: sections by STRONG/MODERATE/WEAK/UNSUPPORTED, claims ditto, warnings, URLs failed
- Computes composite score (0-100, higher is cleaner)
- Prints per-theater breakdown
- Appends a line to `data/seat-research-eval/history.jsonl`
- Saves full report to `results/{timestamp}-{version}.json`

### Step 4: Iterate the prompt

Copy `prompts/v1.md` → `prompts/v2.md`, tweak the rules (e.g., add a new anti-fabrication rule, reorder source hierarchy), and re-run the cycle. Tag the new run with `--prompt-version=v2`.

### Step 5: Compare versions

```bash
node scripts/eval-seat-research.js --compare v1 v2
```

Shows composite delta + unsupported/warning deltas between the latest run of each version. Pick the winner before scaling to 38 theaters.

## Composite score formula

```
sectionScore = 50 * (STRONG*1.0 + MODERATE*0.7 + WEAK*0.3) / sections_total
claimScore   = 50 * (STRONG*1.0 + MODERATE*0.7 + WEAK*0.3) / claims_total
warningPenalty = min(warnings, 20)
composite = max(0, sectionScore + claimScore - warningPenalty)
```

100 = every section and every claim rated STRONG, zero warnings.
Realistic aspirational target for a clean prompt: **80+**.
Current baseline (v1, Majestic + Music Box post-fix): TBD — run the harness to find out.

## Known limits

- The "golden" here is the adjudicator's ratings, not human ground truth. Measures "does this prompt produce less LLM-detectable fabrication," not absolute correctness.
- Adjudicator itself can err. If the adjudicator is miscalibrated (e.g., too lenient), prompts may score high while still producing bad claims.
- Cost: each eval run = ~5 theaters × ~6 sections × ~6 evidenceUrl fetches = ~180 URL fetches (cached) + ~30 Claude calls. Roughly $1-2 per full eval run with Sonnet.

## Files

| File | Purpose |
|---|---|
| `test-set.json` | 5 theaters with difficulty labels. Don't change without bumping prompt version. |
| `prompts/v1.md` | Baseline research prompt. Versioned; never edit in place. |
| `prompts/v2.md` | (future) Iteration. Document what changed from v1 at the top of the file. |
| `history.jsonl` | Append-only log, one line per eval run. Trend-track composite score over time. |
| `results/*.json` | Full reports per run. |
