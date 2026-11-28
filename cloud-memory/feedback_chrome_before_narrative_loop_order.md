---
name: Dual-classifier loops — check exclusion BEFORE inclusion
description: When a line can match both an exclusion pattern (chrome) and an inclusion pattern (narrative), check exclusion first or chrome lines that look narrative will steal the loop
type: feedback
originSessionId: fc8f9fec-3b64-47b3-82a8-85a6a8959dc3
archived: true
---
When you write a loop that decides whether to skip or stop on each line using two classifiers (one for "this is junk, skip" and one for "this is what I want, stop"), the ORDER of the checks matters and the natural order is the wrong one.

Natural-but-wrong:
```js
for (const line of lines) {
  if (isWanted(line)) { result = line; break; }   // narrative check first
  if (isJunk(line)) continue;                     // chrome check second
  break;  // ambiguous — stop here
}
```

A chrome line like "By Jesse Green for The New York Times." has 8 words and ends with a period — `isNarrative` returns true (5-words-plus-sentence-punctuation rule), and the loop stops at the chrome line. The chrome wins.

**Right order: check exclusion FIRST.**

```js
for (const line of lines) {
  if (isJunk(line)) continue;                     // chrome check first
  if (isWanted(line)) { result = line; break; }   // narrative check second
  break;
}
```

**Why:** Exclusion patterns are usually more specific and authoritative ("starts with 'By' / 'Review:' / 'Photo:'"). Inclusion patterns are heuristic and shape-based ("5+ words ending in a period", "starts with a narrative starter word"). When a line matches BOTH, the specific signal should win.

**How to apply:** Any time you have a "skip junk, stop at content" loop with overlapping classifiers, reorder. Also: audit your inclusion-pattern vocabulary — words like "From / As / But / Now" can start chrome lines too ("Now playing at the Booth Theater", "From the producers of..."). Either remove them from the narrative-starter list, or rely on the chrome-first ordering to catch them.

Caught 2026-04-27 by Codex adversarial review (Session C, Lost Boys Issue #9 / Gap 5) on `scripts/lib/pull-quote-guards.js` `stripLeadingChrome`. Original loop checked narrative first; my own fixture tests didn't catch it because all chrome lines in the fixtures had short headers without sentence punctuation. The adversarial review constructed a chrome line that DID satisfy narrative shape and proved the gap.
