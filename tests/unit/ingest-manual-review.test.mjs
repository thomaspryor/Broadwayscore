// BRO-995 acceptance criteria names this exact command:
//   node --test tests/unit/ingest-manual-review.test.mjs
// The real coverage lives in the three colocated suites below (8-field
// invariant, collision detection, merge-onto-flagged-file behavior) —
// re-exported here rather than duplicated so this file can never drift
// from the tests that actually exercise ingest-manual-review.js.
import './ingest-manual-review-fields.test.mjs';
import './ingest-manual-review-collision.test.mjs';
import './ingest-manual-review-merge.test.mjs';
