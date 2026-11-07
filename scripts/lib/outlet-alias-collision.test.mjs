// BRO-2371 acceptance entry point: the real suite (hyphen/concatenated
// near-duplicate coverage, task #1844) lives in tests/unit/ and is manifest-registered in CI.
// This shim lets `node --test scripts/lib/outlet-alias-collision.test.mjs`
// (the card's VERIFY command) run it from the lib directory too.
import '../../tests/unit/outlet-alias-collision.test.mjs';
