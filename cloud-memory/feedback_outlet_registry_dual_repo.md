---
name: outlet-registry.json must be updated in both public and private repos
description: CI uses private repo's outlet-registry.json — changes to public repo alone don't take effect in CI
type: feedback
---

outlet-registry.json exists in both the public Broadwayscore repo AND the private broadway-scorecard-data repo. CI's checkout-core-data action copies from the private repo, overwriting the public version.

**Why:** Session wasted time when outlet tier/alias fixes passed locally but failed in CI. The checkout-core-data action does `cp -f` from the private repo clone.

**How to apply:** After modifying data/outlet-registry.json, also copy it to ~/broadway-scorecard-data/outlet-registry.json and push both repos. Same applies to commercial.json and other files in the private data repo.
