// BRO-5834: keep the card's acceptance command runnable. The production fix
// and its regression coverage already live in the shared auth-health suite.
// Reuse those tests so this entry point cannot drift from the real helpers.
import '../../tests/unit/check-claude-auth-health.test.mjs';
