---
name: feedback_map_iterator_spread
description: Never use spread syntax on Map.keys/values/entries — tsconfig target blocks it. Use Array.from() instead.
type: feedback
originSessionId: 03331355-b799-4a61-9faa-8c76f85a8e6e
---
**Rule:** Never write `[...map.keys()]`, `[...map.values()]`, or `[...map.entries()]`. Use `Array.from(map.keys())` instead. Same for `Set`.

**Why:** tsconfig.json uses `target: "es5"` without `downlevelIteration: true`. The spread syntax on iterable objects (Maps, Sets, custom iterators) requires one of these flags. It builds fine locally sometimes but fails in CI on the Vercel deploy workflow with:
```
Type error: Type 'MapIterator<string>' can only be iterated through when using the '--downlevelIteration' flag or with a '--target' of 'es2015' or higher.
```

This has broken deploys at least twice (2026-04-13 on `src/lib/data-video-critics.ts`).

**How to apply:**
- Grep new TS files for `\[\.\.\..*\.\(keys\|values\|entries\)()\]` before committing.
- `Array.from()` is the safe portable form. Also works for NodeList, HTMLCollection, etc.
- Same pattern applies to `[...mySet]` if iterating a Set — use `Array.from(mySet)`.
- Don't be tempted to flip `downlevelIteration: true` in tsconfig to "fix" this — it bloats output code.

**Related:** Array literal spread of arrays (`[...myArray]`) is fine — es5 supports that. Only iterables require the flag.
