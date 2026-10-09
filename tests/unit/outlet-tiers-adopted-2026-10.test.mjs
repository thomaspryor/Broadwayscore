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

// [outletId, region, adopted tier]
const ADOPTED = [
  ["4columns", "nyc", 2],
  ["a-youngish-perspective", "london", 4],
  ["aaron-in-nyc", "nyc", 4],
  ["act-three-the-reviews", "nyc", 4],
  ["america-magazine", "nyc", 3],
  ["around-the-town-chicago", "nyc", 4],
  ["as-her-world-turns", "nyc", 4],
  ["backstage-barbie", "nyc", 4],
  ["billboard", "nyc", 3],
  ["bobs-theater-blog", "nyc", 4],
  ["broadway-and-me", "nyc", 3],
  ["dc-theater-arts", "nyc", 3],
  ["diandra-reviews-it-all", "nyc", 4],
  ["everything-theatre", "london", 3],
  ["express-uk", "london", 3],
  ["film-festival-traveler", "nyc", 4],
  ["firstnightmagazine", "london", 4],
  ["flipsidereviews", "nyc", 4],
  ["fordham-observer", "nyc", 4],
  ["front-row-center", "nyc", 3],
  ["gotham-playgoer", "nyc", 4],
  ["harry-theatre-life", "london", 4],
  ["jonathan-baz", "london", 4],
  ["labor-press", "nyc", 4],
  ["london-theatre-reviews", "london", 4],
  ["londontheatredirect", "london", 4],
  ["magical-misstari-tour", "nyc", 4],
  ["melindas-malarky", "nyc", 4],
  ["monstagigz", "london", 4],
  ["nyc-theatre-addict", "nyc", 4],
  ["off-off-online", "nyc", 3],
  ["onin", "london", 4],
  ["parade", "nyc", 3],
  ["partially-obstructed-view", "nyc", 4],
  ["partially-obstructed-view", "london", 4],
  ["pinkprincetheatre", "london", 4],
  ["pop-dust", "nyc", 4],
  ["popbytes", "nyc", 4],
  ["readaboutstuff", "london", 4],
  ["reviewsgate", "london", 3],
  ["revstanstheatreblog", "london", 4],
  ["seatplan", "london", 4],
  ["south-london", "london", 3],
  ["splash-magazines", "nyc", 4],
  ["the-contending", "nyc", 4],
  ["the-globe-and-mail", "nyc", 2],
  ["the-knockturnal", "nyc", 4],
  ["the-three-tomatoes", "nyc", 4],
  ["theater-in-the-now", "nyc", 4],
  ["theater-pizzazz", "nyc", 3],
  ["theatre-bee-uk", "london", 4],
  ["theatre-vibe", "london", 3],
  ["theatre-weekly", "london", 3],
  ["times-square-chronicles", "nyc", 3],
  ["uinterview", "nyc", 4],
  ["unmissabletheatre", "london", 4],
  ["viewfromthegods", "london", 4],
  ["vox", "nyc", 3],
];

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
