---
name: Venue tokens collide with same-named people in critic prose
description: Substring-matching on theater venue names ("Belasco", "Sondheim", "Barrymore") false-rejects legitimate reviews because Broadway theaters are named after playwrights/composers/actors who get cited in critic prose constantly. Always corpus-probe before shipping a token-based wrong-production validator.
type: feedback
originSessionId: dac78469-ef10-45a2-9c69-dd091013f178
archived: true
---
When building a wrong-production heuristic that matches on venue tokens, **single-word tokens collide with same-named people** at high rates. Broadway/West End theaters are routinely named after playwrights, composers, actors, and producers — and those people get referenced in critic prose for unrelated productions all the time.

Real examples found in 2026-04-30 corpus probe (10k real reviews):
- "Belasco" — David Belasco the playwright, NOT Belasco Theatre
- "Hudson" — Hudson Yards (neighborhood), NOT Hudson Theatre
- "Neil Simon" — Simon the playwright, NOT Neil Simon Theatre
- "Stephen Sondheim" — Sondheim the composer, NOT Stephen Sondheim Theatre
- "Ethel Barrymore" — Barrymore the actress, NOT Ethel Barrymore Theatre
- "John Golden" — Golden the playwright, NOT John Golden Theatre

A v1 SERP validator using single-word venue tokens hit 2.13% false-rejection rate over 10k reviews — silently dropping legitimate signal. v2 (multi-word only) cut to 0.46%, but person-named venues still triggered (Sondheim, Barrymore, Golden have multi-word forms that ARE the famous person's full name). v3 dropped sibling-venue check entirely; URL-domain-gated cross-market hit 0.08%.

**Why:** the structural collision is unfixable by tokenization. Any venue named "[FirstName] [LastName] Theatre" will match references to that person in unrelated reviews. Adding "must be near 'Theatre'" context still fails because "at the Stephen Sondheim" / "the Stephen Sondheim production" appear without the suffix in headlines.

**How to apply:**
- Before shipping a token-based wrong-production heuristic on a corpus of theater reviews, run a corpus probe over ≥5k existing reviews. Measure false-rejection rate. Tolerance: < 0.5%.
- Prefer URL/domain-based signals (theguardian.com mentioning Old Vic = real wrong-production; nytimes.com mentioning Old Vic = transfer-history reference).
- Never trust same-name string matching when the venue is named after a person — Broadway has Sondheim, Barrymore, Hayes, Golden, Booth, Hirschfeld, Shubert, Belasco, Lyceum, Walter Kerr, Vivian Beaumont, Neil Simon, Lena Horne, August Wilson, Lunt-Fontanne, etc. All are people's names.
- Add an env-var rollback gate (e.g., `SERP_PREFETCH_VALIDATOR=off`) for any new pre-fetch filter — heuristic mistakes can drop signal silently.

**Origin:** 2026-04-30 ship-check on `scripts/lib/serp-candidate-validator.js`. Two reviewers (Claude QA + Codex) independently identified the issue; corpus probe quantified it.
