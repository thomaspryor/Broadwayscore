---
name: LLM eval patterns (BWSC)
description: "Lib layout, 3-point validator, real-iteration loop, golden fixtures."
type: feedback
originSessionId: 09ef1ea1-8b7f-4a13-b1b5-753f64a8b2c3
---
BWSC has LLM-based processes in several pipelines (review classification, wrong-production detection, pull-quote extraction, theater tips, buzz classifier, score calibration, etc.). We converged on the patterns below after shipping evals for theater tips and buzz classifier on 2026-04-15. Follow these rather than re-inventing.

**Why:** A clean eval pass proves nothing if you haven't run the model. The first-pass theater-tips eval blessed production data that had 12 real hallucinations. Real iteration = inspect actual model output → find patterns the validators miss → add checks → re-run → measure. Skip the iteration, skip the value.

**How to apply:**

### 1. File layout (match this)
```
scripts/lib/<name>-validators.js        # pure decision functions, exported
scripts/evals/<name>-eval.js            # offline eval harness, exits non-zero on finding
tests/unit/<name>-validators.test.mjs   # require()s the real lib, not a copy
tests/fixtures/<name>-golden/           # real model outputs + hand-labeled cases
package.json → "eval:<name>"            # npm run entrypoint
```

Don't put validation logic in the generator only, don't copy it into tests. Extract to `scripts/lib/<name>-validators.js` and export. This is the CLAUDE.md §15 test extraction pattern, same as `scripts/lib/review-guards.js`.

### 2. The three-point validator pattern
Every LLM process needs validators usable in three places with the same code:
- **Eval**: offline, runs against captured output (no API burn). Ships in CI.
- **Runtime guard**: inside the generator, rejects or strips bad LLM output at write time. So prompt regressions can't ship.
- **Unit tests**: `require()` the validators, pin every observed failure pattern.

If any of the three is missing, iteration drift will leak. See `scripts/generate-theater-tips.js` — same `detectBannedClaims()`, `validateSubwayFacts()`, `validateEntranceAddress()` run at both write time and eval time.

### 3. Iteration loop (don't skip steps)
1. **Build** schema validators + 1-2 obvious banned-claim patterns (what's the known incident?).
2. **Run** the real model on ~10 fresh cases. Don't reuse cached output — that data was cleaned post-incident.
3. **Read** the raw output. You will find failure modes the validators don't catch. Write them down.
4. **Extend** validators to cover the new failure modes.
5. **Tighten** the prompt if the failure is systematic.
6. **Re-run** on the same 10 cases. Measure pre-guard and post-guard failure rate.
7. **Save** 3-5 real outputs (2 clean + 2-3 regression) as golden fixtures.
8. **Run** the eval against production data. You will find bugs. Fix them.

Stopping at step 1 and calling it done is the failure mode this memory is guarding against.

### 4. Golden fixtures = real model output, not synthetic
Hand-crafted fixtures lie. They test what you imagined failing, not what actually fails. The theater-tips fixtures are all real Gemini Flash outputs captured during iteration — clean cases and regression cases. Commit them to `tests/fixtures/<name>-golden/*.json`.

Exception: for decision-boundary tests (buzz-classifier `is-relevant-cases.json`) you need hand-labeled cases to measure accuracy. For those, construct 15-20 cases that target each boundary the prompt explicitly enumerates (future tense, boycott, different show, venue talk, etc.) and include a `rationale` field explaining why each label is what it is. If a case fails, the failure tells you whether the LLM is wrong or your label is ambiguous.

### 5. Truth tables beat regex for factual claims
For cross-checking claims against ground truth (MTA lines at stations, theater addresses, etc.), use a hardcoded truth table in the validator. Don't try to fuzzy-match or LLM-judge the fact. Theaters don't move, subway lines don't change — this data is stable. See `SUBWAY_STATION_LINES` and `THEATER_VALID_ENTRANCE_STREETS` in `scripts/lib/theater-tips-validators.js`.

### 6. Runtime guard options (pick per field)
When the runtime guard catches bad output:
- **Strip to null**: better than wrong. Use for factual claims where partial info is still useful (e.g. theater tips — shipping other fields is fine, null subway is acceptable).
- **Skip the whole entry**: use when the bad claim is safety-adjacent (e.g. accessibility hallucination). Whole-entry skip is correct for banned-claim findings.
- **Retry once with explicit schema**: use for schema-only failures (buzz-classifier does this via the `explicit=true` arg to `buildPrompt`).

### 7. Threshold-based eval exits (for accuracy metrics)
Binary validators exit non-zero on ANY finding. Accuracy validators (like buzz-classifier-eval) exit non-zero only below a **threshold** — because some disagreement is normal even with humans. Current thresholds:
- `buzz-classifier-eval`: is_relevant ≥ 90%, sentiment ≥ 70%
- `theater-tips-eval`: zero findings (no accuracy metric — binary truth-table checks)

Raise thresholds as you iterate. Never lower them silently.

### 8. API key fallbacks for eval runs
If the process uses multiple providers (buzz-classifier chains Kimi → Gemini → GPT-4o → Claude), ensure the eval works with whichever is available. Check keys with `echo ${KEY:+SET}` before running. Don't hardcode one provider.

### 9. Notion cards are mandatory for eval work
Eval work is Product infrastructure. Create a card with the problem, iteration findings, and acceptance criteria. Update on close with before/after numbers. See `memory/notion-brain-workflow.md`.

### 10. Files to read before starting a new eval
- This memory
- `memory/feedback_scoring_delta_required.md` (for scoring-logic evals)
- `scripts/lib/theater-tips-validators.js` (canonical example)
- `scripts/evals/theater-tips-eval.js` (canonical eval harness)
- `scripts/evals/buzz-classifier-eval.js` (canonical accuracy eval — uses thresholds)
- `tests/unit/theater-tips-validators.test.mjs` (canonical test file with golden fixtures)

### What NOT to do
- Don't claim eval is "done" when you haven't iterated at least once against real model output.
- Don't write a fixture set of synthetic strings and call that a golden dataset.
- Don't put all validation in the generator — eval won't exist as a separate CI gate.
- Don't skip extracting to a lib module — you'll end up with drift between test and runtime.
- Don't raise the accuracy threshold if the eval is close to passing — fix the prompt or the fixture instead.
- Don't eval the wrong file: check whether the site reads `data/theater-metadata.json` vs `data/theater-tips-draft.json` vs the merged output. Always eval the file the site actually reads. Ship-check 2026-04-15 caught 12 subway hallucinations shipping live because the prior eval only scanned the draft.

### 11. Fixture ground-truth sanity check (MANDATORY)
When mining fixtures from production data with human-edit flags, verify the flag actually reflects what the LLM was asked to check. Common bug: a review file has `wrongProduction:true` because it was mis-filed in the wrong folder — the LLM was given the correct showTitle and correctly said "valid", so it's not an LLM failure. Content-verifier eval 2026-04-15 had to filter cases where `folderName !== showId-in-file`. Always apply this kind of consistency check before trusting labels.

### 12. Benchmark providers, not just prompts
When an LLM eval is stuck (precision won't move with prompt iteration), test alternate providers before giving up. Same eval harness, different provider → often reveals the floor is the model's fact-checking capability, not the prompt. Content-verifier 2026-04-15: Gemini Flash FP rate 86.7%, GPT-4o FP rate 66.7% on same fixture. Not a prompt fix — a model choice. Log the finding; the user decides whether the cost delta is worth it.

**Pattern: model sweep harness.** Same fixture × N providers → comparison table with precision/recall/cost/latency. Canonical example: `scripts/evals/content-verifier-model-sweep.js`. Write a stand-alone benchmark script that duplicates the prompt (acceptable drift risk for benchmarking) and calls each provider directly. Then present a Pareto-front table to the user. 2026-04-15 sweep across 7 models for $1.79 total surfaced Haiku 4.5 as the clear winner — 80% precision vs Gemini's 52% for $114/yr extra. Ship the sweep tool with the eval so future iterations can re-run when models change.

**Watch out for fixture artifacts that bias model rankings.** When my fixtures sliced text to 4000 chars, stricter models (Sonnet/Opus/Kimi) flagged the artificial cutoff as truncation and went to ~0% recall, making them look broken. They were behaving correctly on the input I gave them. Always sanity-check the bottom-of-table results — if a strong model scores at 0%, check the prompt/fixture before concluding the model is bad.

### 13. Iteration outcomes are honest, not always positive
Some iteration rounds produce improvement. Others reveal a hard floor — the model genuinely can't do the task at the cost point. Report the finding either way. "Prompt iteration did not move the needle, GPT-4o gave a 20pp improvement at ~10x cost" is a valid iteration outcome. Don't hide failed iterations; document them so future sessions don't repeat them.
