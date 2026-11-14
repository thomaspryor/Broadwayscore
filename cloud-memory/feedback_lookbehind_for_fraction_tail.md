---
name: Lookbehind required when fraction + word-form patterns coexist
description: When `X stars` and `X/5` patterns share the same input, the trailing `5 stars` of `3/5 stars` will match the word-form regex and return 100 instead of 60.
type: feedback
originSessionId: a97024db-80fe-4390-980a-840a895de55d
archived: true
---
# Lookbehind required for fraction + word-form coexistence

If your extractor has BOTH a fraction pattern (`X/5`) AND a word-form pattern
(`X stars`, `X out of 5`), the word-form will match the trailing digit of the
fraction. `3/5 stars` matches both:

- `(\d)/5\s+stars` → captures 3, returns 60
- `(\d)\s*stars` → captures 5 (the second digit of 3/5), returns 100

The order they're tried matters: word-form first → returns 100 (wrong).
Fraction-form first → returns 60 (correct).

## How to apply

Two combined defenses, both required:

1. **Order patterns deliberately.** Try the more-specific fraction form FIRST,
   then word forms. The fraction match consumes both digits; subsequent
   pattern searches won't re-find the trailing digit because `String.matchAll`
   advances past the match.

2. **Lookbehind on word forms.** Use `(?<![\d/])` so the standalone digit
   isn't preceded by a digit OR a slash. This catches the case where the
   fraction pattern's keyword constraint failed (e.g. trailing `.` instead of
   `stars`) but the word-form would otherwise still pick up the orphan `5`.

Hit twice in `extractNYSRScore` 2026-04-25 (ship-check rounds 1 + 2). Final
locked form:

```js
const numericPatterns = [
  /(\d)\s*\/\s*5(?=\s+(?:stars?\b|★|☆|rating\b))/gi,    // X/5 first
  /(?<![\d/])(\d)\s*stars?\b/gi,                          // word form
  /(?<![\d/])(\d)\s*out\s*of\s*5\b/gi,
];
```

Same pattern likely applies to: `extractUKStarRating`, `extractGenericStarRating`,
any Out-of-N extractors. Audit when modifying.
