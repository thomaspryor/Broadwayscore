// BRO-5684: mid-article publisher chrome (Postmedia register modal, Third Coast
// Review newsletter signup) must not make a full article tier `invalid`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isGarbageContent, stripMidTextChromeBlocks, classifyContentTier } = require('./content-quality.js');

const PROSE = 'The cast sings with real conviction and the orchestra drives the score through every number. '.repeat(30);
const POSTMEDIA = 'THIS CONTENT IS RESERVED FOR SUBSCRIBERS ONLY Subscribe now to read the latest news. SUBSCRIBE TO UNLOCK MORE ARTICLES Subscribe now. REGISTER / SIGN IN TO UNLOCK MORE ARTICLES Create an account or sign in to continue with your reading experience. THIS ARTICLE IS FREE TO READ REGISTER TO UNLOCK. Sign In or Create an Account Email Address Continue or View more offers If you are a Home delivery print subscriber, online access is included in your subscription. Activate your Online Access Now';
const TCR = "Never Miss a Moment in Chicago Culture Subscribe to Third Coast Review's weekly highlights for the latest and best in arts and culture around the city. In your inbox every Friday afternoon. Enter your email address Subscribe";

test('Postmedia register modal mid-article is not garbage', () => {
  const t = `Review: Clue Article content ${PROSE} Article content ${POSTMEDIA} Article content ${PROSE}`;
  assert.equal(isGarbageContent(t).isGarbage, false);
  assert.ok(!/sign in to continue/i.test(stripMidTextChromeBlocks(t)));
});

test('Third Coast Review newsletter signup mid-article is not garbage', () => {
  const t = `Review: Hamilton ${PROSE} ${TCR} ${PROSE}`;
  assert.equal(isGarbageContent(t).isGarbage, false);
  assert.ok(!/Enter your email/i.test(stripMidTextChromeBlocks(t)));
});

test('block is replaced by a newline, sentences stay separate', () => {
  const out = stripMidTextChromeBlocks(`${PROSE}${TCR}${PROSE}`);
  assert.ok(out.includes('\n'));
});

test('classifyContentTier does not tier a full article with the block invalid', () => {
  const r = classifyContentTier({ fullText: `Review: Clue ${PROSE} ${POSTMEDIA} ${PROSE}`, url: 'https://example.com/a' });
  assert.notEqual(r.contentTier, 'invalid', r.tierReason);
});

test('negatives: start phrase without end phrase is left alone', () => {
  const t = `${PROSE} THIS CONTENT IS RESERVED FOR SUBSCRIBERS ONLY Subscribe now to read more.`;
  assert.equal(stripMidTextChromeBlocks(t), t);
});

test('negatives: gap beyond maxGap is left alone', () => {
  const t = `${PROSE} THIS CONTENT IS RESERVED FOR SUBSCRIBERS ONLY ${'x '.repeat(2500)} Activate your Online Access Now`;
  assert.equal(stripMidTextChromeBlocks(t), t);
});

test('negatives: paywall stub (block with almost no article) stays garbage', () => {
  const t = `Review: Clue ${POSTMEDIA}`;
  assert.equal(stripMidTextChromeBlocks(t), t);
  assert.equal(isGarbageContent(t).isGarbage, true);
});

test('negatives: teaser followed by the block at the end (paywall stub) is not stripped', () => {
  const t = `Review: Clue ${PROSE} ${POSTMEDIA}`;
  assert.equal(stripMidTextChromeBlocks(t), t);
  // Left intact: pre-existing trailing-junk handling decides, not this strip.
});

// BRO-5383: The Independent bookmark popover ("Already a member? Log in") sits ahead of the body.
const INDEP = 'Bookmark popover Removed from bookmarks Close popover Become an Independent member to bookmark this article Want to bookmark your favourite articles and stories to read or reference later? Start your Independent Membership today. Join today Already a member? Log in';

test('Independent bookmark popover before the body is not garbage', () => {
  const t = `Who’s Afraid of Virginia Woolf? review Alice Saville ${INDEP} ${PROSE}`;
  assert.equal(isGarbageContent(t).isGarbage, false);
  assert.ok(!/already a member/i.test(stripMidTextChromeBlocks(t)));
  const r = classifyContentTier({ fullText: t, url: 'https://www.independent.co.uk/arts-entertainment/theatre-dance/reviews/x.html' });
  assert.equal(r.contentTier, 'complete', r.tierReason);
});

test('negatives: Independent popover followed by a short teaser (<300 chars) is not stripped', () => {
  const t = `Review ${INDEP} Edward Albee's play opens with a bang and then`;
  assert.equal(stripMidTextChromeBlocks(t), t);
});

test('negatives: Independent popover as the whole text (paywall stub) stays garbage', () => {
  const t = `Review ${INDEP}`;
  assert.equal(isGarbageContent(t).isGarbage, true);
});

// BRO-6212: Daily Express Reach plc email signup inlined mid-article (Benjamin Button West End review).
const EXPRESS = 'Get the latest news and gossip from the Royal Family plus selected offers and competitions I would like to receive emails from the Daily Express featuring our latest products, services, offers, and promotions from across the Reach Plc family . Subscribe Invalid email You agree you are 18 or over. We use your sign-up to provide content in ways you\'ve consented to and to improve our understanding of you. This may include adverts from us and third parties based on our knowledge of you. You can unsubscribe at any time. More Info .';

test('Express Reach newsletter signup mid-article is not garbage', () => {
  const t = `Benjamin Button musical review 5 / 5 stars ${PROSE} ${EXPRESS} ${PROSE}`;
  assert.equal(isGarbageContent(t).isGarbage, false);
  assert.ok(!/Royal Family/i.test(stripMidTextChromeBlocks(t)));
  const r = classifyContentTier({ fullText: t, url: 'https://www.express.co.uk/entertainment/theatre/1975202/x-review' });
  assert.equal(r.contentTier, 'complete', r.tierReason);
});

test('negatives: Express signup as the whole text stays garbage', () => {
  assert.equal(isGarbageContent(`Review ${EXPRESS}`).isGarbage, true);
});

// Older Express template: same block, ends "Read our Privacy Policy" (im-not-being-funny, romeo-and-juliet 2026).
const EXPRESS_OLD = 'Get the latest news and gossip from the Royal Family plus selected offers and competitions Subscribe Invalid email You agree you are 18 or over. We use your sign-up to provide content in ways you\'ve consented to and to improve our understanding of you. This may include adverts from us and third parties based on our knowledge of you. You can unsubscribe at any time. Read our Privacy Policy';

test('Express older signup wording (Read our Privacy Policy) mid-article is not garbage', () => {
  const t = `Romeo and Juliet review ${PROSE} ${EXPRESS_OLD} ${PROSE}`;
  assert.equal(isGarbageContent(t).isGarbage, false);
  assert.ok(!/Royal Family/i.test(stripMidTextChromeBlocks(t)));
  const r = classifyContentTier({ fullText: t, url: 'https://www.express.co.uk/entertainment/theatre/1/x-review' });
  assert.equal(r.contentTier, 'complete', r.tierReason);
});

test('negatives: Express older signup as the whole text stays garbage', () => {
  assert.equal(isGarbageContent(`Review ${EXPRESS_OLD}`).isGarbage, true);
});
