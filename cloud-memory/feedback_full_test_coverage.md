---
name: full-test-coverage
description: "Clean-input pass ≠ guard works; push a real violation through CI."
type: feedback
originSessionId: 1a6d672f-d805-477a-861a-fdd48b35e6d6
archived: true
---
Default to full testing, not partial. User explicitly: "Yes, always."

**Why:** Claiming a guard works because it passed on clean input is a false positive — the job of a guard is to BLOCK bad input. Without pushing a real violation through CI, you haven't tested the guard; you've tested that CI runs. Same logic applies to banned-pattern regexes (test each, not one representative) and UI changes (never skip visual verification, even on admin pages or near-identical color swaps).

**How to apply:** When shipping any validation, guard, or lint rule:
1. **Positive case:** input passes when clean (you almost always do this)
2. **Negative case — each rule:** deliberately introduce a violation for every banned pattern, confirm each one is caught. One sample is not enough.
3. **End-to-end in CI:** push a throwaway violation to a branch and confirm CI goes red. A passing CI on clean code does not prove the guard blocks PRs.
4. **Local build:** run `next build` or the equivalent full build, not just `tsc --noEmit`.
5. **UI changes:** visual verification on dev server at mobile + desktop, even if the change is "just a token swap." CLAUDE.md §5 has no exceptions.

If short on time, say which gaps are open — don't silently skip them.
