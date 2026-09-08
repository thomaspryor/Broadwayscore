---
name: feedback-guard-throw-needs-caller-check
description: "Adding a throw to a spend/validation guard converts fail-open into a SILENT REROUTE when the caller catches-and-continues; validate config at startup instead. Also: never infer per-call attribution from a shared module-global counter."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4e545032-2b98-4412-8965-3c9e43f1e588
  modified: 2026-09-08T16:00:13.709Z
---

Two mistakes I shipped in BRO-3009 Sprint 1 and had to fix in the same session, both caught by /ship-check, both invisible to unit tests because each test exercised the guard directly rather than through its real caller.

**1. A throw is only "fail loud" if nobody catches it.** I replaced a fail-open budget comparison (`spent + credits > NaN` is false) with a throw. But `scripts/collect-review-texts.js`'s tier runner wraps `tier.execute()` in `try/catch { ...; continue; }`, so the throw became a per-review tier failure that fell through to the NEXT provider — turning a malformed `SB_PAGE_CREDIT_BUDGET` into "every ScrapingBee fetch silently becomes a Bright Data fetch at ~15x cost", with no distinguishing log. That is worse for the operator than the fail-open it replaced.

**Why:** validation placed on the hot path inherits the hot path's error handling. A tiered fallback pipeline is *designed* to treat an exception as "this provider didn't work, try the next one" — it cannot tell a provider failure from a config error.

**How to apply:** before adding a throw to a guard, grep the call chain for `catch` between the throw and the process boundary. If anything catches-and-continues, validate at STARTUP instead (module load / arg parse) so the run dies before spending anything. Also parse strictly — `parseInt('200oops')` is `200`, so a finite-number check alone accepts values nobody typed; require `/^\d+$/` on the trimmed string.

**2. Never derive per-call attribution from a shared module-global counter.** I labelled telemetry rows by diffing `getScrapingdogCapStats().blockedByBreaker` around a tier call, reasoning "the counter only moves while the breaker is tripped, and a tripped breaker blocks this call too." That reasoning is unsound: the counter is shared with concurrent `fetchPage()` calls and with the SERP path, breaker state caches 60s, and the tier can await ~135s — so a breaker tripping mid-await lets another caller's block mislabel a row whose own call actually ran and billed. Fix was an `onSkip(reason)` callback the tier invokes for its own call, which changes no return value and so touches no routing.

**How to apply:** if you need to know why *this* call did something, have the callee report it for this call. A counter delta is a guess whenever anything else can increment it. "It only moves under condition X, and X implies my case" is the shape of the wrong argument — check whether X can begin or end *during* the await.

Both fixes are encoded at the sites ([[feedback_systematic_fix_threat_model_first.md]]); this file exists for the judgment that generalizes to the remaining spend-guard sprints on these same files.
