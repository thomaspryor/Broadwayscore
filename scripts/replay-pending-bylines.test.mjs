// Acceptance entry point. CI collects these suites through the
// scripts/lib/*.test.mjs glob, so this shim is EXCLUDED from collection.
// BRO-4408: newest-first pending drain order.
import './lib/opening-night-poller-pending-drain.test.mjs';
import './lib/pending-drain-order.test.mjs';
// BRO-2735: zero-text _pending stubs are loud (alert/re-fetch) + stale-_pending age guard.
import './lib/replay-pending-zero-text.test.mjs';
