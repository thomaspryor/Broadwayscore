---
name: git add data/audit/*.json doesn't stage deletions — use -u when scripts delete marker files
description: When a workflow's script can DELETE files in data/audit/ (not just create/update), the workflow's stage block must include `git add -u data/audit/` alongside the create/update line. Without -u, deletions never propagate to main and downstream gates can stay permanently tripped. Caught 2026-04-27 ship-check on verify-all-scored markers.
type: feedback
originSessionId: 4a88f5bf-d40d-4933-882a-0b534879c331
archived: true
---
**Rule:** Any workflow that runs a script which can call `fs.unlinkSync()` or `fs.rmSync()` on files under `data/audit/` MUST stage with both:
```bash
git add data/audit/*.json 2>/dev/null || true
git add -u data/audit/ 2>/dev/null || true
```

**Why:** `git add data/audit/*.json` matches files in the working tree against the glob. A file that has been DELETED from the working tree no longer matches the glob, so its deletion is never staged. Result: the file persists in main forever, even though local state has it deleted.

**Concrete failure mode:** scripts/verify-all-scored.js writes `data/audit/orphan-unscored-{showId}.json` markers and deletes them on resolution (via `gcStaleMarkers` and `clearMarker`). The opening-night-broadcast gate reads these markers to decide whether to block the email. Without `-u`, a cleared marker stays in main; the next broadcast trip permanently blocks unless `force_broadcast=true`. Round-1 ship-check caught this.

**How to apply:** Inside any workflow's commit block:
```yaml
git add data/audit/*.json 2>/dev/null || true
# Stage deletions of marker files. verify-all-scored.js (and any future script
# that deletes audit files) needs -u to propagate deletions to main.
git add -u data/audit/ 2>/dev/null || true
```

**Class audit (2026-04-28):** Swept all 53 workflows that stage `data/audit/*.json`. Only `verify-all-scored.js` (in rebuild-fast.yml + rebuild-reviews.yml) actually deletes files — already fixed. `health-check.js purgeOldExclusionLogs` deletes `.jsonl` files but those are gitignored. No other workflow needs the fix today.

**Future-proofing:** When writing a NEW script that touches `data/audit/`, ask: "does this script ever delete a file there?" If yes, the calling workflow's commit block must include `git add -u data/audit/`.
