// Pins the outlet tier moves adopted from the October 2026 audit (BRO-4907, BRO-4930).
// Evidence per outlet: docs/audits/outlet-tier-audit-2026-10.{md,csv}.
// Reads through the real lookup (scripts/lib/outlet-tiers.js getTier), so a
// later edit to src/config/outlet-tiers.json that undoes a move fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getTier } = require("../../scripts/lib/outlet-tiers.js");

const CATEGORY = { nyc: "broadway", london: "west-end" };

// [outletId, region, adopted tier], shared with scripts/verify-outlet-tiers-published.test.mjs
const ADOPTED = require("./outlet-tiers-adopted-2026-10.json").rows;

test("every adopted 2026-10 tier move resolves through getTier", () => {
  const wrong = ADOPTED.filter(([id, region, tier]) => getTier(id, { showCategory: CATEGORY[region] }) !== tier)
    .map(([id, region, tier]) => `${id} ${region}: expected T${tier}, got T${getTier(id, { showCategory: CATEGORY[region] })}`);
  assert.deepEqual(wrong, []);
});

test("outlets the audit kept on purpose did not move", () => {
  assert.equal(getTier("broadwaynews", { showCategory: "broadway" }), 1);
  assert.equal(getTier("medium", { showCategory: "broadway" }), 3);
  assert.equal(getTier("thereviewshub", { showCategory: "west-end" }), 2);
  assert.equal(getTier("londontheatre1", { showCategory: "west-end" }), 2);
});
