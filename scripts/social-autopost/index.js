// Entry for `node --test scripts/social-autopost/` (BRO-7413 VERIFY): node runs a directory through
// its index.js, and the runner does not expand directories. Load this folder's tests from here.
import('./notability.test.mjs');
