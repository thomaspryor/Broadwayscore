// CI collects only scripts/*.test.mjs (unit-test-collection.js scans scripts/ non-recursively), so this
// pulls in the tests that live beside the code they cover (scripts/social-autopost/).
import './social-autopost/notability.test.mjs';
