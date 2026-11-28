# Fixing private data from cloud (moved from .claude/CLOUD.md, BRO-7631)

Don't clone and push the private repos. Route the edit through CI (BRO-4216):

**Field edits: generate the plan.** `node scripts/new-fix-plan.js --id=bro-N --summary="..." --edit='<showId>.<field>=VALUE' --review-edit='<show>/<file>.json:<field>=VALUE'` (`--help` for more). It fills `oldValue`, splits at 25 actions, runs preflight, force-adds the files and prints the step 3 command. Otherwise:

1. Write `data/pending-fixes/bro-N.json` by hand: shape and every action type (review-field-edit, review-file-op, data-edit, add-commercial-entry, retire-show, drop-orphan-key, retitle-show, add-show, ingest-html-handoff for a page CI can't fetch) are in `scripts/pending-fix-actions.md`.
2. `node scripts/lib/preflight-review-fix-plan.js <plan>` (replays data-edits, so a stale `oldValue` fails here), `git add -f` the plan, then land (`land/<name>`).
3. After the land is on main: `node scripts/cloud-dispatch.js execute-approved-fix.yml -f issue_number=bro-N -f plan_id=<planId> -f mode=apply --wait` (exit 0 = applied). It pushes the private repos (no owner email for `bro-*` plans: report in chat and Linear). Red if any action was refused.
4. The apply run dispatches `rebuild-fast.yml` (live ~15 min later).

Never put review text or reader contact details in a plan: the file is public.

