---
name: outlet-registry public→private sync gap
description: Adding an outlet to data/outlet-registry.json in the PUBLIC repo doesn't propagate to the private broadway-scorecard-data repo on first rebuild — checkout-core-data overwrites the public file with the stale private version. Caught Innocence Met Opera 2026-04-27.
type: feedback
originSessionId: 81c92010-44e0-44c8-8637-ba42ac06c82a
archived: true
---
When you add a new outlet (or update outlet-registry.json) and a CI rebuild runs immediately:

1. `actions/checkout@v5` pulls public repo (with your outlet-registry.json change) into workspace
2. `.github/actions/checkout-core-data` clones broadway-scorecard-data PRIVATE repo to /tmp/core-data-checkout, then **copies all .json files including outlet-registry.json INTO data/, overwriting your public-repo version**
3. `rebuild-all-reviews.js` reads `data/outlet-registry.json` (now the STALE private-repo version)
4. New outlets fall through to fuzzy-prefix alias-match (e.g., `newyorkclassicalreview` matches Vulture's `newyork` alias → outlet maps to Vulture, tier 1)
5. Push step copies the now-rebuilt outlet-registry.json BACK to private repo — but only the `_meta.lastUpdated` timestamp changed, and the missing aliases are still missing because the rebuild read them from a copy that didn't have them in the first place. **Wait, actually the rebuild did NOT change outlet-registry.json content — it only reads it. So the public→private push of outlet-registry.json should have used the public file content.** Re-investigate.

Empirical sequence we observed (2026-04-27, Innocence):
- 16:36 UTC — added NYCR + CVA to public outlet-registry.json, pushed to public main
- 17:51 UTC — Fast rebuild ran, output put George Grella (NYCR) under "Vulture" tier 1
- 17:51 UTC — private repo's outlet-registry.json `_meta.lastUpdated` updated, but content still missing NYCR/CVA
- 18:05 UTC — second Fast rebuild, same broken Grella attribution
- 18:09 UTC — manually pushed outlet-registry.json to private repo via `gh api`
- 18:14 UTC — third Fast rebuild correctly resolved Grella → New York Classical Review tier 3

**Why:** The push-core-data action does `cp -f data/outlet-registry.json /tmp/core-data-checkout/` BUT the `Sync core data files to checkout` step in push-core-data/action.yml has a `[ -f /tmp/core-data-snapshot/$f ] && cp from snapshot` fallback, AND the `Snapshot rebuilt core data` step copies from `data/` (which was already overwritten by the private-repo version in step 2). So the snapshot itself contains the stale registry.

**How to apply:**
- After adding any outlet to the public outlet-registry.json, **directly push to the private repo first**: `gh api repos/thomaspryor/broadway-scorecard-data/contents/outlet-registry.json --method PUT -f message=... -f content="$(base64 -i data/outlet-registry.json | tr -d '\n')" -f sha="$(gh api repos/thomaspryor/broadway-scorecard-data/contents/outlet-registry.json --jq .sha)"`
- THEN trigger Fast rebuild — first attempt will pick up the private-repo version that's now in sync.
- Symptom of the bug: a new outlet's review shows under WRONG outlet display name in /show/<id> per-show JSON. Check the fuzzy-prefix alias-match in `scripts/lib/review-normalization.js:332-351`.
- Other vulnerable outlet IDs: any new outlet whose slug starts with a prefix that matches an existing outlet's alias slug ≥6 chars long. `new-york-*` outlets all collide with Vulture's `newyork` alias. `the-*` outlets safe. `arts-*` outlets safe.

**Architectural fix needed:** push-core-data should preserve the public-repo version of outlet-registry.json (since public repo is the source of truth for it), or checkout-core-data should NOT overwrite tracked files that exist in the public repo. Or move outlet-registry.json out of the private repo entirely (it has no copyrighted content).
