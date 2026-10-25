---
name: ensemble-score-sequential-dispatch
description: llm-ensemble-score.yml show_id dispatches share one cancel-in-progress concurrency group — parallel dispatches cancel each other; run sequentially
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a45cfd38-1be0-4824-adb8-4b47657739fd
---

`gh workflow run "LLM Ensemble Score Reviews" -f show_id=X` for several shows in
quick succession silently self-destructs: all show_id dispatches share the
default `scoring-reviews` concurrency group with cancel-in-progress, so each new
dispatch CANCELS the previous one. Only the last run survives. The cancelled
runs report conclusion `cancelled` (wait scripts print FAILED), and the
not-scored shows just stay unscored — no error anywhere. Happened 2026-07-12:
3 dispatches (pride/equus/avenue-q), 2 cancelled, looked like scoring failures.

**Why:** serialization is intentional (parallel runs would race on the data-repo
llm-scores push); only `rescore_reason`-targeted runs get separate groups.

**How to apply:** dispatch per-show scoring runs SEQUENTIALLY — wait for each
run (scripts/lib/wait-for-run.sh) before dispatching the next. If a scoring run
shows `cancelled`, check whether a newer ensemble run superseded it before
diagnosing. Same applies to "Rebuild Reviews (Fast)" vs "Rebuild Reviews Data"
— they share a group; a cancelled fast rebuild usually means the full rebuild
took over (its success covers the fast one's work).
