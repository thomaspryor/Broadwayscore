---
name: orphan-slim-show-files
description: "public/data/shows/{id}.json must exist for an id in shows.json — orphan slim files split show state and silently break audience-buzz merge"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9aa69087-81a3-4c0d-8e2a-e2e42e1a4ff9
---

`public/data/shows/{id}.json` files whose `id` doesn't appear in `data/shows.json` are orphans. They happen when:

- A show is renamed/consolidated in `shows.json` but the old slim file isn't cleaned up.
- The audience pipeline still has the old slug in `data/show-score.json` keys, so it writes audience data into the old-id slim file even though the canonical show now lives under a new id.

Result: state for a single show is split across two files (audience-only at the old id, critic-only at the new id), and the audience block is missing from the canonical slim file the front-end reads. The Can I Be Frank case (2026-05-24) sat in this split state because `can-i-be-frank-off-broadway-2026` was retained alongside `morgan-bassichis-can-i-be-frank-off-broadway-2026`.

**Why:** Multiple writers (rebuild, audience pipeline, social-pulse, etc.) write into `public/data/shows/` keyed by IDs from different sources. There's no enforced cross-check against `shows.json` at write time.

**How to apply:**
- CI gate: `scripts/audit-orphan-show-ids.js` in `test.yml`. Fails on orphan slim files; reports `data/show-score.json` and `audience-buzz` key drift as advisory (pass `--strict` to also fail on those).
- To clean locally: `node scripts/audit-orphan-show-ids.js --fix` deletes orphan slim files.
- `show-score` / `audience-buzz` orphans require manual rename of the JSON keys (the pollers persist whatever slug they last saw).
- `.social` suffix files in `public/data/shows/` are auxiliary social-pulse data and not validated against `shows.json`.

Related: [[feedback_duplicate_of_url_mismatch]], [[dual-repo-data-files]] (`feedback_dual_repo_data_files`).
