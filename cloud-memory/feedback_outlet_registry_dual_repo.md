---
name: outlet-registry.json is public-owned (superseded dual-repo rule)
description: SUPERSEDED by BRO-1084 - outlet-registry.json is tracked in the public repo and editable from cloud; the old copy-to-private-repo rule no longer applies
type: feedback
---

**Superseded (BRO-1084, re-checked 2026-10-30 for BRO-6635):** outlet-registry.json is public-owned now. It is tracked in this repo, `checkout-core-data` skips it, and `push-core-data` syncs it to the public repo. Edit and land it here only, cloud sessions included; do not copy it to the private repo. The rest of this note is history.


outlet-registry.json exists in both the public Broadwayscore repo AND the private broadway-scorecard-data repo. CI's checkout-core-data action copies from the private repo, overwriting the public version.

**Why:** Session wasted time when outlet tier/alias fixes passed locally but failed in CI. The checkout-core-data action does `cp -f` from the private repo clone.

**How to apply:** After modifying data/outlet-registry.json, also copy it to ~/broadway-scorecard-data/outlet-registry.json and push both repos. Same applies to commercial.json and other files in the private data repo.
