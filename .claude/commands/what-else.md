Every piece of work reveals something you didn't expect. Find the adjacent improvements, investigations, and quick wins before the context fades.

## When to use

Run `/what-else` at the end of a session (before or after `/wrap-up`) when you've done meaningful work and want to capture what it revealed. The best ideas come from noticing what's adjacent to what you just built — not from brainstorming in a vacuum.

## Instructions

### Phase 1: Inventory the session

Review what was done this session:
```bash
git log --oneline -10
git diff --stat origin/main
```

Identify the key changes: what was built, fixed, or discovered.

### Phase 2: Five lenses

Apply each lens to the session's work — ALL FIVE, every run, no exceptions.

**Output contract (MANDATORY):** your reply must contain a `LENSES:` block with
one line per lens, each citing the concrete check you ran (a grep/read/command
or the specific session artifact examined), ending in either a spark or an
explicit empty verdict:

```
LENSES:
1. Pattern recognition — grepped commercial.json writers for market/category scoping → 2 cousins found (fixed) / clean
2. Edges — [check] → [spark or "empty"]
3. User impact — [check] → [spark or "empty"]
4. Data/infra — [check] → [spark or "empty"]
5. Compounding — [check] → [spark or "empty"]
```

"Empty" is a legitimate verdict per lens; a **blanket "no new sparks" without
the five evidence lines is a violation** — it means the analysis didn't happen
(2026-07-15: a session invoked /what-else, asserted no-sparks from vibes, and
the user caught it; when re-run properly the lenses found real cousins to check).
"Skip lenses that don't produce insights" applies to what you REPORT as sparks,
never to whether a lens is run.

**1. Pattern recognition**
- Did we create something that solves a problem elsewhere too? (A component, script, helper, approach)
- Did we fix a bug that has cousins? (Same class of error in other files/workflows)
- Did we learn something about the data that changes assumptions elsewhere?

**2. Edges and boundaries**
- What did we almost build but decided against? Why? Has anything changed?
- What did we discover was harder than expected? What does that imply about adjacent work?
- Where did we hit the edges of the current architecture?

**3. User impact**
- Does this change how a user experiences something? What's the next thing they'd want?
- Does this create a new entry point, page, or flow? What's missing from it?
- Would a user notice this improvement? If not, what would they notice?

**4. Data and infrastructure**
- Did we touch data that revealed quality issues, gaps, or opportunities?
- Did we use a workflow or tool in a new way that could be generalized?
- Is there data we're now collecting that we're not yet using?

**5. Compounding improvements**
- What would make this change 10x more valuable? (Not 10x more complex — 10x more valuable)
- What's the "obvious next step" that someone would ask about?
- If we did this three more times, what pattern emerges?

### Phase 3: Filter and prioritize

**Read the current roadmap** to avoid duplicating existing items (mandatory —
run the command; the LENSES block plus this read are the two things that make
a /what-else pass real rather than performative):
```bash
gh issue view 1 --repo thomaspryor/broadway-scorecard-data --json body -q '.body' 2>/dev/null || cat memory/roadmap.md
```

From all the sparks generated, keep only the ones that are:
- **Actionable** — someone could start on this in the next session
- **Valuable** — worth the effort, not just interesting
- **Non-obvious** — not already on the roadmap (check against what you just read)

**Quality over quantity.** 3-5 sparks with depth beats 7 shallow ones. If you have more than 5, cut the weakest.

### Phase 4: Present

**Session:** [one-line summary of what was done]

Sort sparks into tiers with effort estimates:

**Do now** (this session — quick wins or things with active context advantage):
- [spark] — [why it matters] (~N min)

**Start now in parallel session** (worth doing today but independent):
- [spark] — [why it matters] (~N min). Prompt: "[ready-to-paste prompt for new session]"

**Roadmap** (good ideas that don't need today's context):
- [spark] — [why it matters]

### Phase 5: Create Notion cards (MANDATORY — do not ask, just do it)

For EVERY spark in **Roadmap** and **Start now in parallel session** tiers, create a Notion card in the BWSC Roadmap (data source: collection://fa7b3ff2-c073-4097-b54c-0a78e56e06b6):
- **Name:** the spark title
- **Status:** "Not started"
- **Priority:** P1 Next for parallel/urgent, P2 Later for roadmap items
- **Tags:** appropriate subsystem tags
- **Notes:** Self-contained handoff using this structure:
  ```
  ## Problem — [what's wrong or needed]
  ## Evidence — [show IDs, error counts, commands]
  ## Root cause — [if known]
  ## Suggested approach — [file paths, functions, commands]
  ## What was already tried — [failed attempts]
  ## Acceptance criteria — [how to verify]
  ```
  Self-check: "Could a fresh session act on this in under 2 minutes?"

Do not ask permission. Do not suggest. Create the cards, then report what you created.

### Phase 6: Act — do not ask

**DO the "Do now" items immediately** — never ask "Want me to do the now items?" (that's the banned defer-question; the finish-line gate blocks it). Then, in your final message, triage EVERY card you created so the user knows exactly what's required of them:
- **Do now** → already done by you (report the result)
- **Start now in parallel session** → include the full ready-to-paste prompt inline (a card link alone is NOT a handoff)
- **Roadmap** → one line: why it can wait and what would promote it

Never present new cards as a bare list of links — the user shouldn't have to ask "what are the priorities of these, and who does them?"
