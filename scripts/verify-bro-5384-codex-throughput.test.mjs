// BRO-5673: compatibility entry point for the card's stale VERIFY command.
// This runs the offline optimization acceptance suite, not a live throughput
// measurement. It proves routing, caps and retry schedules still hold without
// depending on credentials or a historical count of firings. Outstanding live
// evidence is documented in docs/specs/bro-5673-verification.md.
// CI runs the imported suites individually; this alias is EXEMPT_NEVER_CI to
// avoid duplicate execution in the collected batch.
import './batch-session-optimization.test.mjs';
