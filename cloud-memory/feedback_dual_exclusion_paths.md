---
name: Rebuild has dual exclusion paths — clear BOTH wrongProduction AND incompleteReason
description: "Rebuild excludes on wrongProduction AND incompleteReason; clear BOTH."
type: feedback
originSessionId: 7b6d6742-e899-49d4-83cf-798849c08a43
archived: true
---
When unflagging a wrongProduction review, must clear BOTH `wrongProduction` AND `incompleteReason`.

**Why:** The rebuild has two independent exclusion paths. `wrongProduction` prevents scoring. `incompleteReason: "wrong_content"` is set by a separate classification pass and survives even when wrongProduction is cleared. Additionally, `restore-protected-fields.js` preserves incompleteReason/incompleteDetail across rebases — deleting the fields locally gets undone on the next `git pull --rebase`.

**How to apply:** When clearing wrongProduction on any review file:
1. Set `wrongProduction: false` + `wrongProductionManualClear: true`
2. Delete `incompleteReason` and `incompleteDetail` if they say "wrong_content" / "Wrong production"
3. After pushing, verify the next rebuild includes the review (check `{show}: N reviews` in rebuild log)
4. If incompleteReason reappears after rebase, it means restore-protected-fields.js put it back — push the clear again immediately after the rebase commit
