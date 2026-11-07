---
name: feedback_property_stub_misses_internal_calls
description: "stubbing a CommonJS module's exported property (cmuxws.run = fake) does NOT intercept that module's own internal calls — a test harness that stubbed only .run reached the real cmux daemon and closed the live watchdog tab; stub by name every function reachable, or use the module's injection seam"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9639aaab-b2ee-4ba3-815f-81e405cd0463
  modified: 2026-09-08T02:25:12.181Z
---

Assigning to an exported property (`cmuxws.run = stub`) only redirects callers that go
*through the export*. The module's own functions call the **internal binding**, so they are
untouched. In `scripts/lib/cmux-workspaces.js`, `closeWorkspace()` and `listWorkspaces()`
both call the module-local `run` — so a harness that stubbed `cmuxws.run` believed it was
isolated, and `ensureTab()`'s "existing tab is stale — recreating" branch called
`cmuxws.closeWorkspace()` straight through to the **real cmux daemon**, closing the live
`👑 OWNER watchdog` dashboard tab mid-session (2026-09-07, BRO-3001). The give-away was in
the harness's own output: it printed a workspace ref that the stub never returned.

**Why:** `module.exports.run = x` rebinds a property on the exports object; `function
closeWorkspace(){ run(...) }` resolves `run` lexically in the module scope. They are two
different references to what was the same function. This is invisible in the harness —
there is no error, the stub simply never fires, and the side effect is real.

**How to apply:**
- Prefer the module's **injection seam** when it has one. This repo's real tests do it right:
  `run(args, { execFn })`, `reconcileTaskSessions({ listWorkspacesFn, reportFn })`. Verified
  no repo test uses property-stubbing — this trap was confined to a scratch harness.
- If you must property-stub, stub **every exported function the code under test can reach**,
  not just the one you think it calls (`closeWorkspace`, `listWorkspaces`, `sendToWorkspace`
  as well as `run`), and make each stub record its calls so you can assert nothing escaped.
- Before running any harness that can reach a live daemon/API, ask what the **destructive**
  branch is and neutralise it first. `ensureTab()` closes a tab before recreating one; that
  branch was reachable the moment the fake HOME made the heartbeat look missing.
- Read the harness's output against the stub's return values. A ref/ID you never handed it
  means a call escaped.

Related: [[feedback_test_through_the_runner_seam]], [[feedback_test_pure_function_at_io_boundary]],
[[feedback_never_close_unmarked_cmux_workspaces]].
