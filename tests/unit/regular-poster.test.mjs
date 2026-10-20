// BRO-5795: the small-blog tier rule and the two held-back-review bugs found with it.
// Requires the real functions (CLAUDE.md §15), no copied logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const rp = require("../../scripts/lib/regular-poster.js");
const g = require("../../scripts/lib/review-guards.js");

test("newOutletTier: blog platforms start at T4, everything else T3", () => {
  assert.equal(rp.newOutletTier("someblog.blogspot.com"), 4);
  assert.equal(rp.newOutletTier("https://www.foo.wordpress.com/post"), 4);
  assert.equal(rp.newOutletTier("foo.substack.com"), 4);
  assert.equal(rp.newOutletTier("nytimes.com"), 3);
  assert.equal(rp.newOutletTier(""), 3);
  assert.equal(rp.newOutletTier("notwordpress.com.example.org"), 3);
});

test("isFullTextWrongAuthorActive: a stale flag is ignored once the byline attests the name", () => {
  const text = "Safe House\nBy Alix Cohen\nThe play opens with a long and detailed scene.";
  assert.equal(g.isFullTextWrongAuthorActive({ fullTextWrongAuthor: true, criticName: "Alix Cohen", fullText: text }), false);
  assert.equal(g.isFullTextWrongAuthorActive({ fullTextWrongAuthor: true, criticName: "Someone Else", fullText: text }), true);
  assert.equal(g.isFullTextWrongAuthorActive({ fullTextWrongAuthor: true, criticName: "Alix", fullText: text }), true);
  assert.equal(g.isFullTextWrongAuthorActive({ criticName: "Alix Cohen", fullText: text }), false);
  assert.equal(g.isFullTextWrongAuthorActive(null), false);
  const ap = { fullTextWrongAuthor: true, _authorMismatch: "AP wire content detected in non-AP file: x", criticName: "Alix Cohen", fullText: text };
  assert.equal(g.isFullTextWrongAuthorActive(ap), true);
});

test("duplicateOfInheritedFlag: own affirming CV beats a twin's nonReview, otherwise it still inherits", () => {
  const twin = { isNonReview: true, fullText: "x" };
  const show = { id: "s", status: "open", category: "broadway" };
  const cv = { isValid: true, confidence: "high", articleType: "review" };
  const own = { duplicateTextOf: "twin.json", contentVerification: cv };
  assert.equal(g.duplicateOfInheritedFlag(own, twin, show, "twin.json"), null);
  const noCv = { duplicateTextOf: "twin.json" };
  assert.equal(g.duplicateOfInheritedFlag(noCv, twin, show, "twin.json"), "nonReview");
  const lowCv = { duplicateTextOf: "twin.json", contentVerification: { ...cv, confidence: "medium" } };
  assert.equal(g.duplicateOfInheritedFlag(lowCv, twin, show, "twin.json"), "nonReview");
});

test("explainShowLevelExclusion mirrors the rebuild's show-level skips", () => {
  assert.equal(g.explainShowLevelExclusion({ status: "upcoming" }), "upcomingShow");
  assert.equal(g.explainShowLevelExclusion({ status: "previews", category: "broadway" }), "previewsShow");
  assert.equal(g.explainShowLevelExclusion({ status: "previews", category: "west-end" }), null);
  assert.equal(g.explainShowLevelExclusion({ status: "open" }), null);
  assert.equal(g.explainShowLevelExclusion(null), null);
});
