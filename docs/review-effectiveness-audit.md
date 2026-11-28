# Review-process effectiveness audit

Task #1218. Owner escalation 2026-08-10: six-reviewer `/plan-review` passed a plan whose
first gate was "5 shows through new tooling"; the obviously safer "2 shows by hand
first" never surfaced from any of the six reviewers. The owner caught it in one read
and asked "how did we get so much plan review but not think of that?" This document is
the hit/miss audit behind that question, grounded in the actual transcript and the
review ledger, not a restatement of the card.

## Method

Two sources, both real, both directly inspected — no sampling of memory or summaries:

1. **The full transcript of session `5f71081d`** (`~/.claude/projects/-Users-tompryor-Broadwayscore/5f71081d-465d-46a5-b460-4c8c6b29bed3.jsonl`), which ran the WE historical-backfill plan-review that triggered this card. All six reviewer outputs, the synthesis, the owner's question, and the session's own self-diagnosis are in there verbatim.
2. **`.claude/review-verdicts.jsonl`**, the ledger every `/ship-check`, `/second-opinion`, `/code-review`, and `/plan-review` run writes a pass/fail line to. 1,305 entries, 2026-07-13 through 2026-08-10, parsed directly (not summarized).

## Finding 1 — the case study: reviewers critique the plan as framed, never the framing

The six reviewers on the WE historical-backfill plan (Codex, Gemini, and four Claude
lenses — structure/devil's-advocate, pre-mortem, user-impact, code-design) each did
real, substantive work. The structure/devil's-advocate reviewer alone raised 8 distinct
findings, including:

> "S2 bundles 4 independent collectors (TR, WET, direct-URL, SERP) plus budget
> checkpointing plus resumability into one sprint. The TR extension is the
> highest-risk piece … and **should be isolated and verified alone before being
> folded into a combined-cost pilot** — otherwise a TR bug is invisible inside an
> aggregate '5 shows E2E' number."

That is the 2-show-smoke-test idea, stated almost exactly, by a reviewer, unprompted.
The synthesis phase (Phase 4 of `/plan-review`) turned it into a **gate-criteria
bullet** in the revised plan — an item under "E2E gate with concrete verify" — instead
of restructuring the plan's ramp. The revised plan that shipped to the owner still had
"full pipeline on 5 shows first" as sprint S2's opening move. The owner asked "wouldn't
it be wise to try it on 2 shows first?" and the session's own answer, verbatim from the
transcript:

> "1. Reviewers critique the plan as framed — they don't re-frame it. The plan already
> had a '5 shows first' gate, so every reviewer saw *a* ramp and hunted for missing
> guards inside that structure instead of asking 'is the first step as small as it
> could be?' Adversarial reviewers are tuned to find failure modes, not to shrink scope.
> 2. One reviewer actually got close and I under-weighted it. […] That's on my
> synthesis, not the review.
> 3. […] 'what's the smallest run that teaches us the same thing?' None of the six
> lenses asks that question explicitly."

Two distinct, separable failures, not one:

- **Reviewer-level:** five of six reviewers never generated a scope/ramp challenge at
  all — not because the review missed something in the code, but because no lens is
  designed to ask "could this ramp be smaller?" The prompts optimize for finding flaws
  *inside* a given structure (correctness, gaps, failure modes, design fit) — none of
  the six asks whether the structure itself is right-sized.
- **Synthesis-level:** the one reviewer that did surface it got folded into a
  correctness-shaped fix ("isolate and verify" became a bullet under a QA gate) instead
  of triggering a distinct "should the plan's shape change?" question to the user.
  Synthesis (Phase 4) had no mechanism to distinguish "this finding wants a new gate"
  from "this finding wants the plan restructured."

## Finding 2 — the first fix for this already landed, and never shipped

`~/.claude/commands/plan-review.md` (the global copy, mtime 2026-08-09 20:21) already
carries a Q10b "smallest viable first increment" addition, added the same day as the
incident. **The repo copy at `.claude/commands/plan-review.md` (mtime 2026-08-06,
predates the fix) never received it.** Every local Claude Code session in this repo
loads the repo copy, not the global one (confirmed by the session-start
COMMAND-FILE-DRIFT warning this session itself received). So the fix for "reviewers
never challenge the ramp" existed for a full day, credited as shipped, and was
**invisible to every session working in this repo** — including any session that might
have caught this exact pattern on a different plan in the interim.

This is not a one-off slip. It is a structural gap: skill fixes authored in a
`~/.claude` session don't reach repo-scoped sessions without an explicit sync step, and
nothing enforces that step at commit time. (Fixed as part of this task — see Fixes
Shipped below. The general sync problem is out of scope here; it is a known, tracked
issue per the session-start drift warning.)

## Finding 3 — the ledger cannot support hit/miss analysis, by construction

Root cause #3 named in the card: "no feedback loop measures which review findings ever
mattered." Quantitative confirmation from `.claude/review-verdicts.jsonl` (1,305
entries, 2026-07-13 to 2026-08-10):

| Metric | Value |
|---|---|
| Total verdicts recorded | 1,305 |
| **Pass** | 1,300 (99.6%) |
| **Fail** | 5 (0.4%) |
| By reviewer | ship-check 1049, second-opinion 222, code-review 23, plan-review 7, codex 2, gpt-4o 1, test 1 |
| Plan-phase (`phase:'plan'`) verdicts | 40 — of which second-opinion wrote 32, plan-review wrote 7, test wrote 1 |
| Entries carrying a free-text `note` | 37 (all since 2026-08-06 — the field is four days old) |

Three separate problems, all visible in this table:

1. **The ledger only ever records "reviewed: pass/fail," never *what was found* or
   *what changed*.** A verdict that means "ran six reviewers, found three P0s, fixed
   them, re-verified" is byte-for-byte indistinguishable from one that means "glanced
   at the diff, nothing to say." 1,300 passes with no findings payload is not evidence
   the process is working — it's an unfalsifiable record. The 5 recorded fails are the
   only signal in 1,305 entries that a review *changed* an outcome, and even those
   carry no detail on what failed or why.
2. **`/second-opinion` does more plan-review work than `/plan-review` itself** (32 vs.
   7 recorded plan-phase verdicts) — the lighter-weight, single-reviewer tool is the
   one actually catching most plans before implementation. Any redesign of the
   six-reviewer skill that ignores `/second-opinion` is optimizing the tool used 18%
   of the time, not the one used 82% of the time. (This audit's fixes therefore
   apply to both — see below.)
3. **`/right-problem` never writes to the ledger at all** (confirmed: zero
   `right-problem` entries in the reviewer breakdown, and reading
   `.claude/commands/right-problem.md` end to end shows no `record`/`record-plan`
   call anywhere in it). Its own Phase 1 documentation says it should run *before*
   `/plan-review` for anything over a day of work — but there is no way to audit
   whether it ever does. `/plan-review`'s Phase 0 asks reviewers to "look for
   evidence in the conversation" that it ran, which is exactly the kind of soft,
   easily-skipped check this whole audit is about.

## What this audit does NOT claim

No broader corpus of "past plan-review outputs" beyond the one transcript above was
mined — session transcripts for other `/plan-review` runs exist on disk but are not
indexed or searchable in bulk, and grepping dozens of multi-hundred-KB JSONL files for
a pattern as soft as "did a reviewer suggest smaller scope" would produce more false
signal than real. The ledger's lack of findings-level detail (Finding 3) is precisely
what makes that kind of retrospective mining unreliable — which is itself the argument
for shipping the instrumentation below rather than attempting a larger manual archaeology
pass now. Future audits should be markedly cheaper once the fixes below have been live
for a few weeks.

## Fixes shipped (not proposals)

1. **Synced the Q10b "smallest viable first increment" fix into the repo copy** of
   `.claude/commands/plan-review.md` (Finding 2) — the fix that was already "shipped"
   but invisible to this repo's sessions is now actually live here.

2. **`/plan-review` Phase 0 rewritten from a soft, skippable check into a mandatory,
   written-answer step.** It now requires stating the plan's first execution step in
   units and explicitly answering "could 1-2 units run by hand first" — before Phase 2
   runs, not as an afterthought. A framing finding surfaced here goes to the TOP of
   Phase 3's output, ahead of the six critiques.

3. **`/plan-review` Phase 4 gets a new mandatory sub-step ("restructure-the-ramp
   escalation")** that scans every reviewer's output — including solo findings — for
   scope/sequencing language ("isolate and verify alone," "test smaller first," "de-risk
   before automating"). When found, it must be pulled out as a standalone "Restructure
   question" and put to the user explicitly, not folded into the consensus table as one
   more P1/P2 row. This directly targets the exact 2026-08-09 failure mode (Finding 1):
   the structure reviewer's finding existed, and synthesis absorbed it into a gate
   bullet instead of a restructure question.

4. **`/second-opinion` gets an equivalent, lighter-weight "Part 0 — is the framing
   right?" step**, added ahead of its correctness/design parts. Given Finding 3's
   32-vs-7 usage split, this is the higher-leverage of the two skill changes — most
   plan review in this repo runs through `/second-opinion`, not the six-reviewer skill.

5. **Effectiveness instrumentation, closing part of Finding 3's "no feedback loop."**
   Both skills, when the new framing/restructure check fires, now stamp the plan-verdict
   `--note` with a `restructure-flag: adopted — <what changed>` or
   `restructure-flag: dismissed — <why the scope stood>` prefix (a convention on the
   existing free-text `note` field, not a new ledger schema — see rationale below).
   `scripts/lib/infra-review-digest.js` (already the pipe that turns the ledger into the
   daily health-check row per task #1095) now counts entries matching that prefix as
   `restructureEscalations`, with a unit test asserting the count. This makes it
   possible to answer, going forward and cheaply, "how often does this actually fire,
   and does the owner adopt or dismiss it?" — the exact question this audit could not
   answer for the *old* process because nothing recorded it.

   **Design note:** the first draft of this instrumentation was a bare
   `restructureFlag: true` boolean on `recordPlanVerdict()`. An independent
   `/second-opinion` review (run per CLAUDE.md rule 18, since `review-gate.mjs` is
   infra-review-gated) caught two problems with that draft: (a) nothing in the plan
   actually wired the flag to get set at either call site, so it would have shipped as
   a permanently-`undefined` field — dead instrumentation; (b) a boolean can't
   distinguish "the escalation fired and the plan's scope changed" from "it fired and
   the owner dismissed it," which is exactly the granularity this card's Finding 1
   needed and didn't have. The note-prefix design fixes both: it's wired at the same
   two call sites that already write `--note`, and it captures outcome, not just
   occurrence.

## What this audit recommends but does not ship (owner call)

- **A recurring, cheap version of this audit** — once `restructure-flag:` notes have
  accumulated for a few weeks, `infra-review-digest.js`'s new count plus a manual read
  of the flagged notes is a much smaller job than this one was. Consider running it
  monthly rather than building further automation now; the manual case-study method
  used here (pull the transcript, read the reviewers, compare to the synthesis) is
  cheap enough at low volume that it doesn't need its own tooling yet.
- **An owner-question corpus** (candidate direction #4 in the card) — recurring
  questions the owner has asked that reviews should have asked. This audit found one
  clean instance (this card's own incident) with a verbatim transcript; a corpus needs
  several more instances to be worth building as standing reviewer questions rather
  than one-off patches like Q10b and this card's Phase 0/Phase 4 changes. Revisit once
  2-3 more instances exist, likely surfaced by the `restructure-flag:` notes above.
