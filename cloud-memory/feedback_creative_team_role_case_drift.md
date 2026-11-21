---
name: creativeteam-role-labels-are-case-sensitive-canonicalize-at-write-site
description: "src/lib/data-creative.ts ROLE_TO_CATEGORIES is exact-case. Case-drift (\"Book writer\" vs \"Book Writer\") silently drops entries from /playwrights, /directors, /composers pages"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9b61d0d3-99ec-4008-8d50-41e963b67f53
---

`src/lib/data-creative.ts` exports `ROLE_TO_CATEGORIES` as an exact-case `Record<string, CreativeCategory[]>`. `getCategoriesForRole(role)` only matches the literal keys (`'Playwright'`, `'Book Writer'`, `'Music'`, etc.) — lowercase or stylized variants fall through to `[]` and the credit is invisible on the corresponding creative-pages.

**Why:** On 2026-05-26 audit found 37 `"Book writer"` (lowercase) entries in `data/shows.json` that were silently absent from /playwrights. Source: LLM proposal in `scripts/auto-fix-show-data.js` wrote whatever case the LLM emitted (lowercase). 57 correct `"Book Writer"` entries existed alongside.

Other drift forms observed in the same corpus:
- `'Book'` (704) vs `'Book Writer'` (57) — both legitimate but downstream treats differently
- `'Music'` (583) vs `'Composer'` (43) — both legitimate variants
- `'Director & Choreographer'` (61) — combined role, not in ROLE_TO_CATEGORIES → invisible

**How to apply:**
1. Any script that writes `show.creativeTeam` MUST canonicalize the role label at write site. Pattern from `auto-fix-show-data.js` (commit 5546775db3):
   ```js
   const ROLE_CANON = {
     director: 'Director', playwright: 'Playwright', choreographer: 'Choreographer',
     'book writer': 'Book Writer', book: 'Book',
     composer: 'Composer', lyricist: 'Lyricist',
   };
   verified.push({ ...member, role: ROLE_CANON[role.toLowerCase()] });
   ```
2. Don't fix the bug by adding a `toLowerCase()` shim in `data-creative.ts` — that masks the data drift. Normalize at write so the data stays clean.
3. When auditing this class of bug, check role-label distribution: `node -e "const d=JSON.parse(require('fs').readFileSync('data/shows.json'));const c={};for(const s of d.shows){for(const r of s.creativeTeam||[]){c[r.role]=(c[r.role]||0)+1}};console.log(Object.entries(c).sort((a,b)=>b[1]-a[1]).slice(0,30))"` — look for case variants of the same label.

Related: [[feedback_isbroadway_takes_object]] — same ship-check #3 audit.
