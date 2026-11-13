// scripts/lib/paywall-split-section.test.mjs — node:test
// Run: node --test scripts/lib/paywall-split-section.test.mjs
//
// BRO-7389. NYT's two-show columns (The Verge + Rope, 2026-11-05; The
// Unbelievers + 2:22 A Ghost Story, 2026-11-06) were fetched WHOLE on opening
// night (5,488 / 5,277 chars) and split to each show's section (1,627 / 2,399
// chars). The hard-paywall check then judged the section against NYT's
// whole-article floor ("Paywall truncation: below_floor:2399<4500"), so the
// rebuild flipped it to truncated, the opening-window recheck re-fetched it
// every run, and hand recovery replaced it with the whole two-show article.
// The fixture below has the shape of The Verge's first-pass record (lengths,
// fields, URL); the prose is placeholder text (review texts are private).
// Real functions only (CLAUDE.md §15).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pc = require('./paywall-completeness.js');
const { splitSourceComplete } = require('./multi-show-review-fanout.js');

const NOW = Date.parse('2026-11-06T12:00:00Z');

function prose(chars) {
  const s = 'The production keeps its nerve and the cast plays the strange text with real conviction. ';
  let out = '';
  while (out.length < chars) out += s;
  return out.slice(0, out.lastIndexOf('.', chars) + 1);
}

// The Verge, first pass (review-texts f978d45cc5b): browserbase, whole
// article 5,488 chars, own section 1,627 chars, ends mid-column (no info box).
function vergeFirstPass(over = {}) {
  const section = prose(1627);
  return {
    showId: 'the-verge-off-broadway-2026',
    outletId: 'nytimes',
    criticName: 'Helen Shaw',
    url: 'https://www.nytimes.com/2026/11/05/theater/rope-the-verge-review-off-broadway-silverman.html',
    category: 'off-broadway',
    firstSeenAt: '2026-11-06T03:42:19.006Z',
    fullText: section,
    contentTier: 'complete',
    contentTierReason: 'multi-show-split: trimmed to own show section',
    sourceMethod: 'browserbase',
    fetchMethod: 'browserbase',
    multiShowSplitParent: true,
    multiShowSplitChildShowIds: ['rope-off-broadway-2026'],
    multiShowSplitAnchorKind: 'joint',
    multiShowSplitOriginalLength: 5488,
    multiShowSplitTextLength: section.length,
    ...over,
  };
}

test('the trap: the raw check fails a split section on length alone', () => {
  const d = vergeFirstPass();
  const a = pc.assessPaywallCompleteness(d.fullText, d.url, { criticName: d.criticName, category: d.category });
  assert.equal(a.complete, false);
  assert.ok(a.reasons.some((r) => r.startsWith('below_floor:')), a.reasons.join(','));
});

test('a split section of a whole article is judged by the article', () => {
  const d = vergeFirstPass();
  assert.equal(pc.isSplitSectionOfCompleteArticle(d), true);
  const a = pc.assessStoredPaywallCompleteness(d);
  assert.equal(a.complete, true, a.reasons.join(','));
  assert.equal(a.splitSection, true);
});

test('rebuild keeps it complete, recheck does not re-fetch it, no truncated patch', () => {
  const d = vergeFirstPass();
  const tier = pc.applyPaywallTierOverride(d, { contentTier: 'complete', tierReason: 'Full review text' }, NOW);
  assert.equal(tier.contentTier, 'complete', tier.tierReason);
  assert.equal(pc.needsPaywallRecheck(d, NOW), false);
  assert.equal(pc.truncatedTierPatch(d), null);
  // Already labelled by an earlier run: the label is lifted, not kept.
  const labelled = vergeFirstPass({ contentTierReason: 'Paywall truncation: below_floor:1627<4500 for nytimes.com (source: browserbase)' });
  assert.equal(pc.applyPaywallTierOverride(labelled, { contentTier: 'complete' }, NOW).contentTier, 'complete');
});

test('the article verdict recorded at split time wins over the length fallback', () => {
  assert.equal(pc.assessStoredPaywallCompleteness(vergeFirstPass({ multiShowSplitSourceComplete: true, multiShowSplitOriginalLength: undefined })).complete, true);
  assert.equal(pc.assessStoredPaywallCompleteness(vergeFirstPass({ multiShowSplitSourceComplete: false })).complete, false);
});

test('still truncated: a partial source article, a regrown text, a paywall prompt', () => {
  // The article itself was under the floor: the section may be cut too.
  assert.equal(pc.applyPaywallTierOverride(vergeFirstPass({ multiShowSplitOriginalLength: 2000 }), { contentTier: 'complete' }, NOW).contentTier, 'truncated');
  // Whole article back in fullText (re-collect): judged as an ordinary text.
  const regrown = vergeFirstPass({ fullText: prose(3000) });
  assert.equal(pc.isSplitSectionOfCompleteArticle(regrown), false);
  assert.equal(pc.needsPaywallRecheck(regrown, NOW), true);
  // A wall inside the section is about the section's own text.
  const prompt = vergeFirstPass();
  prompt.fullText = `${prompt.fullText} Subscribe now to continue reading.`;
  prompt.multiShowSplitTextLength = prompt.fullText.length;
  const a = pc.assessStoredPaywallCompleteness(prompt);
  assert.equal(a.complete, false);
  assert.deepEqual(a.reasons, ['paywall_prompt']);
  // Not a split record at all: unchanged behaviour.
  const plain = vergeFirstPass({ multiShowSplitParent: undefined });
  assert.equal(pc.applyPaywallTierOverride(plain, { contentTier: 'complete' }, NOW).contentTier, 'truncated');
});

test('splitSourceComplete records the whole article verdict, no opinion off hard-paywall hosts', () => {
  const whole = { url: vergeFirstPass().url, category: 'off-broadway', criticName: 'Helen Shaw', fullText: prose(5400) };
  assert.equal(splitSourceComplete(whole), true);
  assert.equal(splitSourceComplete({ ...whole, fullText: prose(1500) }), false);
  assert.equal(splitSourceComplete({ ...whole, url: 'https://www.theatermania.com/x' }), null);
});

// Real data, when the private review-texts checkout is present (Mac / CI
// with private data). The Unbelievers file holds its 2,399-char section of
// the 5,277-char joint column; inside its opening window it must not be
// re-labelled or re-fetched.
const RT = process.env.REVIEW_TEXTS_DIR
  || [path.resolve('data/review-texts'), path.join(process.env.HOME || '', 'broadway-review-texts')].find((p) => fs.existsSync(p));
const UNBELIEVERS = RT && path.join(RT, 'the-unbelievers-off-broadway-2026', 'nytimes--laura-collins-hughes.json');
test('real data: The Unbelievers NYT section stays complete in its opening window', { skip: !(UNBELIEVERS && fs.existsSync(UNBELIEVERS)) && 'private review-texts not present' }, () => {
  const d = JSON.parse(fs.readFileSync(UNBELIEVERS, 'utf8'));
  if (!pc.isSplitSectionOfCompleteArticle(d)) return; // file re-collected whole since; nothing to judge
  const inWindow = Date.parse(d.firstSeenAt) + 24 * 3600 * 1000;
  assert.equal(pc.applyPaywallTierOverride(d, { contentTier: 'complete' }, inWindow).contentTier, 'complete');
  assert.equal(pc.needsPaywallRecheck({ ...d, contentTier: 'complete' }, inWindow), false);
});
