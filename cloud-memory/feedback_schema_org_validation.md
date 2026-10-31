---
name: Schema.org type validation
description: "PerformingArtist doesn't exist; characterName on PerformanceRole."
type: feedback
archived: true
---

Always verify schema.org types and properties against the actual spec before emitting them in JSON-LD. Plausible-sounding types may not exist (e.g., `PerformingArtist` is not a real type — use `Person`). Similarly, properties can belong to wrapper types, not the obvious parent (e.g., `characterName` belongs on `PerformanceRole`, not `Person`).

**Why:** `/second-opinion` caught `PerformingArtist` and `characterName` after the code was already pushed. These would have generated new Google Search Console errors — the exact thing we were trying to fix.

**How to apply:** When adding new schema.org types or properties to `src/lib/seo.ts`, verify at https://schema.org/[TypeName] that the type exists and the property is listed on that type. Google's Rich Results Test can also validate.
