---
name: Audit every dispatch path when changing routing logic
description: When a workflow-dispatch routing rule changes, every endpoint that fires a dispatch needs the same routing — not just the obvious one. Lost Boys 2026-04-27 ship-check found the batch path bypassed the new LLM-scoring fix because /api/admin/dispatch-rebuild was never updated.
type: feedback
originSessionId: 64cf8c86-37ad-4e32-ad67-09338030aa55
archived: true
---
# Audit every dispatch path when changing routing logic

When you add or change a workflow-dispatch routing rule in one endpoint, audit every other endpoint that dispatches workflows for the same flow. They probably need the same logic.

**Why:** Lost Boys 2026-04-27 followup. Commit `b0b762b3e7` fixed Issue #5 (/ingest now dispatches `llm-ensemble-score.yml` when no score on file, otherwise `rebuild-fast.yml`). The single-paste flow worked. But the batch flow at `src/app/admin/ingest/IngestForm.tsx:534-617` commits N files via `/api/admin/ingest-review` with `skipDispatch: true`, then dispatches ONCE via `/api/admin/dispatch-rebuild` — and that endpoint was never touched. It still hardcoded `rebuild-fast.yml`. So batch-mode submissions with unscored fullText still committed-then-rebuilt without scoring, exact same bug as before. Ship-check (Claude general-purpose subagent + Codex adversarial) BOTH flagged this independently.

**How to apply:** Whenever you change a `gh workflow run` / `githubDispatchWorkflow` call site, grep for the workflow name AND for `/api/admin/dispatch-` (or equivalent dispatch endpoints) AND every UI form that posts to those endpoints. Trace each path end-to-end. The fix isn't "update the one route" — it's "update every route that produces the same output, plus every UI flow that orchestrates them."

The cleanest pattern: when the routing decision depends on per-record state (e.g. "does this file have a score yet?"), have the per-record API return that state in its response (`needsScoring: boolean`), and have the orchestrator UI aggregate across records to decide which dispatch to make. That way the routing logic lives in ONE place (the per-record endpoint) and orchestrators just read its output.

## Concrete checklist for the BWSC repo
- `src/app/api/admin/ingest-review/route.ts` (single file)
- `src/app/api/admin/dispatch-rebuild/route.ts` (batch dispatch)
- `src/app/admin/ingest/IngestForm.tsx` SinglePasteForm + BatchPasteForm (both UI flows)
- Any future `/api/admin/*` endpoint that fires `gh workflow run`
- Future opening-night flows: `scripts/opening-night-poller.js`, `scripts/orchestrator-*` — different code paths, same lesson.

## Detection pattern
If any review file in the wave commits successfully but never renders on the live page after the dispatch fires, audit which endpoint dispatched the workflow. If it dispatched `rebuild-fast.yml` directly without first checking whether any committed file lacks a score, you've reproduced this class of bug.
