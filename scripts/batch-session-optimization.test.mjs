// BRO-5673: offline acceptance for the optimization behavior already on main.
// Reuse the tests of the real callers and helpers rather than copying decisions
// or importing the daily runner, which would start work and contact services.
// The imported suites already run in CI. This acceptance shim is excluded from
// collection in scripts/lib/unit-test-collection.js to avoid duplicate runs.
// Live throughput and per-filer land rates are separate operational evidence:
// see docs/specs/bro-5673-verification.md before treating a green run as card closure.
import './lib/cloud-worker-pick.test.mjs';
import '../tests/unit/session-model.test.mjs';
import '../tests/unit/codex-runner-stop-context.test.mjs';
import '../tests/unit/block-prompting-remote-tools.test.mjs';
import '../tests/unit/land-retry-cancelled-schedule.test.mjs';
