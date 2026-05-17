---
name: Outlet canonicalization via URL domain
description: Manual ingest paths must resolve outletId from URL domain + outlet-registry, not operator input; unregistered input + URL = URL wins.
type: feedback
originSessionId: 82f0be84-160a-4528-ae69-ba6a33bbc005
archived: true
---
Manual-ingest scripts (`scripts/ingest-manual-review.js`, `scripts/manual-review-direct.js`) must call `resolveCanonicalOutletId({outletArg, url})` from `scripts/lib/outlet-canonicalize.js` — never write operator-supplied `--outlet=` directly, and never rely on `normalizeOutlet()` alone.

**Why:** On 2026-04-23 Rocky Horror opening, 4 reviews shipped with non-canonical outletIds (`davidcote-substack`, `nystagereview`×2, `newyorktheatreguide`) because the old code path did `normalizeOutlet(outletArg) || slugify(outletArg)`. `normalizeOutlet()` returns the input slug unchanged when the alias isn't registered — so `davidcote-substack` flowed through to disk even though the URL `davidcote1.substack.com` uniquely maps to canonical `cote-notices` in outlet-registry.json. Same class: SIX 2021 `edge-media-network` for a `boston.edgemedianetwork.com` URL (canonical is `edge-boston`). These failed class-C domain-mismatch audits and kept Data Validation red on main ~16 hours.

**How to apply:**
- Any new ingest/extraction path that writes `outletId` must go through `resolveCanonicalOutletId()`.
- URL domain uniqueness (registry `domainToOutlet` minus `AMBIGUOUS_DOMAINS`) is ground truth. Operator input only disambiguates when URL can't.
- If input resolves to a different canonical than URL, prefer URL + warn.
- If input is unregistered AND no URL, slug fallback + warn so the drift is visible.
- Domain-to-outlet logic is shared: audit-review-contamination.js and outlet-canonicalize.js both compute AMBIGUOUS_DOMAINS the same way. Keep them in sync.
- Fixture test: `tests/unit/outlet-canonicalize.test.mjs` — 5 real drift cases + timeout.com ambiguity.
