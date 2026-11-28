// BRO-8433: Australia's mainstream papers must not sit below the blog tier
// band. The Age was T3 while its Nine sister masthead SMH was T2; the News
// Corp metro dailies (Herald Sun, Daily Telegraph) were T3 while their US
// analogue (NY Post) is T2. Reads through the real lookup, so a later edit
// to src/config/outlet-tiers.json or the registry that undoes this fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getTier } = require("../../scripts/lib/outlet-tiers.js");

const AU_MAINSTREAM_T2 = ["age", "smh", "australian", "herald-sun", "daily-telegraph-au", "timeout-sydney"];

test("AU mainstream papers resolve to T2 on regional shows", () => {
  const wrong = AU_MAINSTREAM_T2.filter((id) => getTier(id, { showCategory: "regional" }) !== 2)
    .map((id) => `${id}: T${getTier(id, { showCategory: "regional" })}`);
  assert.deepEqual(wrong, []);
});

test("The Guardian stays T1 for Australian reviews", () => {
  assert.equal(getTier("guardian", { showCategory: "regional" }), 1);
});
