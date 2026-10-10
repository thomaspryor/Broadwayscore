---
name: feedback_monitor_must_cover_own_output
description: "A coverage/drift monitor must exempt or cover its OWN verdict files, or it flags itself into permanent noise"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 33033e68-7b57-4299-9248-9ff7ad95c251
---

A monitor that scans tracked files for a property must account for the file IT
writes — or it eventually flags its own output and becomes the noise it was
meant to surface. Caught in /ship-check (both Claude + Codex reviewers, P1) on
the churn-coverage monitor (`scripts/audit-churn-merge-coverage.js`, 2026-06-26):
its verdict `data/audit/churn-merge-coverage.json` and the sibling
`data/audit/corpus-drift.json` embed a fresh `generatedAt` every run and are
committed by `check-corpus-drift.yml` after each rebuild (~16+ commits/3d and
climbing). Neither had a `.gitattributes` merge driver, so once they crossed the
30-commit/3d floor the monitor would flag them forever — defeating the
non-blocking digest's whole purpose.

**Why:** self-referential noise is the failure mode that silently kills a
monitor's signal-to-noise. It's invisible at ship time (the file is small/new,
below threshold) and only bites weeks later when the output file's own churn
crosses the bar.

**How to apply:** when you build any audit that enumerates files/rows/entities
by a churned property, ask "does my own output match my own predicate?" If yes,
cover it (here: `data/audit/{corpus-drift,churn-merge-coverage}.json merge=ours`,
bot full-snapshots, latest-wins) or exempt it. Dogfood the rule against the
tool's own artifacts before shipping.

Related technique from the same change: a CUSTOM git attribute
(`merge-coverage=exempt`) that git ignores for merging but the audit reads via
`git check-attr`, to declaratively exempt served/human-editable + accumulate-
state files from a churn-vs-merge-driver coverage check — keeps the exemption
list next to the merge policy in `.gitattributes`, not hardcoded in JS. See
[[feedback_gitattributes_merge_driver_semantics.md]] and
[[feedback_test_yml_data_gates_flap_and_shortcircuit.md]].
