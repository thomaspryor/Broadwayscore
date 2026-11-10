/**
 * page-furniture.js — page chrome that extractors carry INTO a review body:
 * share bars, "Related Stories" promo runs, comment widgets, ticket widgets,
 * newsletter/registration prompts, donation appeals, copyright lines and
 * paragraphs the page printed twice (BRO-7171 Stage 5).
 *
 * Why this exists: Stage 4 rolled back 105 gap-recovery accepts whose only
 * "gain" was furniture (a cookie banner, a share bar, a booking line, a
 * repeated paragraph). The acceptance gate now refuses those, but the
 * extractors kept producing the furniture, and ~3,000 stored bodies already
 * carry it (scripts/audit-page-furniture.js). This module is the one
 * definition both the cleaner (text-cleaning.js cleanText, the
 * review-write-guard save chokepoint, the corpus re-clean) and the survey /
 * class-guard test read, so the detector and the stripper cannot drift.
 *
 * Every rule matches a WHOLE line (after trimming and whitespace collapse)
 * against a known chrome shape, never a substring of a prose paragraph. A
 * review sentence that mentions tickets, newsletters or sharing is untouched;
 * the line "Share on Facebook" or "Buy tickets for X with GO London" is not.
 * Authored production info ("Tickets are available at the box office",
 * "Running time: 2 hours") is review copy written by the critic and is NOT
 * furniture here.
 *
 * Kill switch: PAGE_FURNITURE_DISABLED=true makes stripPageFurniture a no-op
 * (the detector still reports, so the survey can measure the off state).
 * TRAILER_FIXES_DISABLED=true (the Stage 0 switch) turns it off too.
 */

'use strict';

const SENTENCE_END_RE = /[.!?…]["'”’)\]]*$/;

// Social / share bar tokens printed one per line.
const SHARE_RE = /^(?:share(?: (?:this|the))?(?: (?:article|story|page|post|review))?|share (?:on|to|via) (?:facebook|twitter|x|linkedin|whatsapp|bluesky|threads|reddit|pinterest|email|e-mail|flipboard)(?: \(opens in new window\))?|share full article|share this:?|tweet(?: this)?|copy link|copy the link|link copied!?|e-?mail(?: this)?(?: article)?|facebook|twitter|x \(twitter\)|whatsapp|pinterest|linkedin|reddit|bluesky|threads|flipboard|messenger|print(?: this)?(?: article| page)?|gift (?:this )?article|save (?:this )?article|(?:facebook|twitter|email|pinterest|linkedin|whatsapp|reddit|print)(?: ?[|·•,] ?(?:facebook|twitter|email|pinterest|linkedin|whatsapp|reddit|print|x)){1,8})[\s:!]*$/i;

// Recirculation labels. A label line alone is chrome; RELATED_BLOCK_RE labels
// additionally take the run of headline lines printed under them.
const RELATED_LABEL_RE = /^(?:related(?: (?:articles?|stories|story|content|posts?|reviews?|links?|coverage|reading))?|read more(?: about this)?|read next|more from [\w'’&. ]{1,40}|more (?:stories|reviews|news|on this story)|you (?:may|might) (?:also )?like|recommended(?: for you| videos?| reading| stories)?|most (?:popular|read|viewed)|trending(?: now| stories)?|also read|popular on [\w'’ ]{1,30}|more from our brands|load more|show more|see all|editor'?s? picks|top stories|latest (?:news|stories|reviews))[\s:]*$/i;
// Labels whose next lines are headlines (Penske Media: Deadline, THR, Variety,
// Rolling Stone, Billboard, IndieWire, Gold Derby all print the module
// mid-article as "Related Stories" + a section word + 1-3 headlines).
const RELATED_BLOCK_RE = /^(?:related(?: (?:articles?|stories|story|content|posts?|links?))?|more (?:stories|news)|recommended(?: stories)?|popular on [\w'’ ]{1,30}|more from our brands|you (?:may|might) (?:also )?like|read next|most popular)[\s:]*$/i;
const HEADLINE_RUN_MAX = 8;
const HEADLINE_MAX = 220;

// Comment widgets.
const COMMENTS_RE = /^(?:leave a (?:comment|reply)|post a comment|add a comment|\d+ comments?(?: \/ \d+ new)?|comments?(?: \(\d+\))?|join the (?:conversation|discussion)|show comments|view comments|comment on this (?:article|story)|show \d+ comments?)[\s:]*$/i;

// Ticket widgets and affiliate booking lines (site-injected, not the critic's
// own "Tickets are available at ..." sentence).
const BOOKING_RE = /^(?:get tickets|buy tickets|book tickets|book now|book here|click here to book|find tickets|check (?:ticket )?availability|tickets from [£$€]\s?\d[\d.,]*|buy tickets for .{1,160}? with (?:go london|independent tickets|time out|[\w'’ ]{1,30} tickets)|(?:buy|book) tickets (?:for .{1,120} )?(?:here|now))[\s.:!]*$/i;

// Known newsletter / registration / paywall / donation / affiliate boilerplate,
// matched as a whole line. Each was found verbatim in stored bodies
// (scripts/audit-page-furniture.js); add a new one with its example in the test.
const BOILERPLATE_RES = [
  // newsletter
  /^(?:sign up|subscribe) (?:for|to) (?:our|the|[\w'’]+(?:\s+[\w'’]+){0,3}) (?:free |daily |weekly )?(?:[\w'’ ]{0,40})newsletters?\b.{0,160}$/i,
  /^for all the latest theatre reviews, sign up to the stage[’']s weekly reviews newsletter\.?$/i,
  /^stay in the loop: sign up to our free time out .{0,60}newsletter.{0,120}$/i,
  /^we help you navigate a myriad of possibilities\. sign up for our newsletter.{0,80}$/i,
  /^by entering your email address you agree to our terms of use and privacy policy.{0,300}$/i,
  /^by providing your information, you agree to our terms of use and our privacy policy.{0,400}$/i,
  /^by (?:signing up|subscribing|clicking .{1,30}), you agree to (?:our|the) .{0,300}$/i,
  /^(?:simply )?enter your email(?: address)?(?: in the box below| below| to follow new comments on this article)?\.?$/i,
  /^newsletter sign ?up\b.{0,600}$/i,
  /^thanks for (?:signing up|subscribing)!?.{0,160}$/i,
  /^sign up for [\w'’ ]{1,30} news straight to your inbox.{0,60}$/i,
  /^(?:subscribe|sign up|log in|sign in|register)$/i,
  // NYT TimesMachine archive notes printed under pre-1996 articles
  /^see the article in its original context from .{1,80}$/i,
  /^new york times subscribers\*? enjoy full access to timesmachine.{0,200}$/i,
  /^\*does not include games-only or cooking-only subscribers\.?$/i,
  /^about the archive$/i,
  /^this is a digitized version of an article from the times[’']s print archive.{0,400}$/i,
  /^occasionally the digitization process introduces transcription errors.{0,200}$/i,
  /^already (?:a subscriber|have an account|registered)\?.{0,160}$/i,
  // registration / paywall prompts
  /^invest in the stage today with a subscription starting at just [£$€]\d+(?:\.\d+)?\.?$/i,
  // The Stage registration wall (2026 pages serve these instead of the body)
  /^(?:🔓 ?)?sign in below or create a free account to read \d+ free articles\.?$/iu,
  /^join over [\d,]+ theatremakers who rely on the stage for trusted news, reviews,? and insight\.?$/i,
  /^coming up next: .{1,80} subscribe now to read in print, or online\.?$/i,
  /^(?:create a free account|register for free|sign in|log in) to (?:continue reading|keep reading|read (?:the full|this) (?:article|story|review)).{0,120}$/i,
  /^registration is a free and easy way to support our journalism\.?.{0,200}$/i,
  /^(?:subscribe|sign up) (?:now |today )?to (?:continue|keep) reading.{0,120}$/i,
  /^this (?:article|content|story) is (?:only )?(?:available )?(?:for|to) (?:subscribers|members)(?: only)?\.?.{0,120}$/i,
  // donation appeals
  /^support arts and culture journalism today\..{0,400}$/i,
  /^support our trusted, fact-based, free-thinking journalism\..{0,200}$/i,
  /^thank you again for your support along the way\. we[’']re truly grateful for readers like you!.{0,600}$/i,
  /^everything in the (?:silver|gold|bronze|platinum) tier.{0,800}$/i,
  /^(?:support|become a (?:member|supporter|patron) of) (?:huffpost|independent journalism|our journalism|the independent)\b.{0,300}$/i,
  // affiliate / saved-product / cookie widgets
  /^your product is saved! you[’']ll receive emails when your saved products go on sale\..{0,60}$/i,
  /^things you buy through our links may earn .{1,40} a commission\.?$/i,
  /^we (?:may )?(?:earn|receive) (?:a )?commission (?:from|on|when) .{0,160}$/i,
  /^(?:we use cookies|this (?:site|website) uses cookies)\b.{0,400}$/i,
  /^(?:accept|reject|manage) (?:all )?(?:cookies|preferences|consent)\.?$/i,
  /^manage preferences\.?$/i,
  // site chrome left as the last line once the share/related furniture above
  // it is cut (BRO-7171 dry run: these exposed endings read as cut-off bodies)
  /^web production by tipit\b.{0,80}$/i, // ny1 footer
  /^(?:\d{1,3}\.){3}\d{1,3}$/, // ny1 prints the client IP under the footer
  /^unlimited digital access ?only .{0,60}$/i, // newsday
  /^the newsday app makes it easier to access content without having to log in\.?$/i,
  /^created with sketch\.?$/i, // variety svg title
  /^access exclusive content$/i,
  /^ad choices$/i,
  /^already a member\? log in to hide these messages\.?$/i, // huffpost
  /^this page has been blocked by an extension$/i,
  /^[\w.-]+\.(?:com|net) is blocked$/i,
  /^follow going out on facebook and on twitter @esgoingout\.?$/i, // standard
  /^get the latest and greatest from the big smoke.{0,140}$/i, // timeout-london
  /^all-access pass to top stories, events and offers around town\.?$/i, // village voice
  // residual chrome found by re-running extraction over data/archives/reviews
  /^number of vendors seeking consent(?: or relying on legitimate interest)?: \d+$/i, // IAB TCF dialog
  /^get the best deals and latest updates on theat(?:re|er) and shows by signing up for .{1,40} newsletter today!?$/i,
  /^the best of [\w ]{1,30} straight to your inbox$/i, // time out
  /^déjà vu! we already have this email\. try another\?$/i,
  /^thank you for signing up!?$/i,
  /^(?:see all )?newsletters$/i, // ap
  /^(?:skip )?advertisement$/i,
  /^advertisement \| advertise on [\w ]{1,30}$/i, // newsday
  /^remember me(?: on this computer)?$/i,
  /^printed from: \S+$/i, // ft print view
  /^print a single copy of this article for personal use\..{0,120}$/i,
  /^get (?:local )?news (?:delivered )?(?:from .{1,60} )?(?:to|in) your inbox[.!]?$/i,
  /^get weekly rundowns straight to your inbox$/i,
  /^sign up to receive daily updates!?$/i,
  /^subscribe for full access to the hollywood reporter$/i,
  /^sign up for the critics$/i,
  /^a weekly dispatch on the cultural discourse, for subscribers only\.?$/i,
  /^(?:email me a log ?in link|admin login|need an account\? sign up|i agree to the subscription terms of use\.?)$/i,
  /^view our media kit and learn all about how to advertise with us\..{0,20}$/i,
  /^follow @ftlifearts on twitter to find out about our latest stories first\..{0,160}$/i,
  // IAB TCF consent-dialog purpose texts (standard wording on every TCF site)
  /^(?:we and our \d+ partners (?:use|store)|please note that your choices apply across|customi[sz]e your consent preferences|cookies, device or similar online identifiers|(?:advertising|content) presented to you on this service can be based on|information about your activity on this service|information regarding which (?:advertising|content) is presented|reports can be generated based on the combination|your data can be used to monitor for and prevent|certain information \(like an ip address|the choices you make regarding the purposes|in support of the purposes explained in this notice|your device might be distinguished from other devices|with your acceptance, your precise location|information about your activity on this service may be matched).{0,700}$/i,
  /^(?:your preferences have been saved ?do not sell or share my personal data|if you switch this toggle to “no,” we will not sell or share).{0,700}$/i, // nypost
  /^thank you for your patience while we verify access\..{0,300}$/i, // nyt bot wall
  /^ad services privacy policy adchoices$/i,
  // AP newsletter promos
  /^(?:the latest ap-norc polls|our flagship newsletter breaks down the biggest headlines of the day\.|get the ap[’']s most compelling photographs sent directly to your inbox\.|get ap[’']s first personalized newsletter.{0,80})$/i,
  /^listen to our free podcast (?:review of the show|going behind-the-scenes on the show):$/i, // whatsonstage
];

// Copyright / publisher lines. Bounded length so a prose sentence that opens
// with "Copyright" is never a match.
// "(c)" counts only before a year or "copyright": a critic's enumerated
// point ("(c) the second act sags") is prose.
const COPYRIGHT_RE = /^(?:©|\(c\)\s*(?:(?:19|20)\d{2}|copyright\b)|copyright\b)[^\n]{0,140}$/i;
const COPYRIGHT_WORDY_GUARD = /\b(?:law|lawsuit|infring|estate|owns? the|holder|claim|dispute)\w*/i;

const REPEAT_MIN = 80;
const TAIL_GUARD_REMOVES = new Set(['share', 'comments', 'booking', 'repeat']);

function normLine(l) {
  return String(l || '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
}

function pageFurnitureEnabled() {
  return process.env.PAGE_FURNITURE_DISABLED !== 'true' && process.env.TRAILER_FIXES_DISABLED !== 'true';
}

/**
 * Category of a single (normalized) line, or null when it is not furniture.
 * @param {string} line
 * @returns {null|'share'|'related'|'comments'|'booking'|'boilerplate'|'copyright'}
 */
function lineFurnitureCategory(line) {
  const t = normLine(line);
  if (!t || t.length > 900) return null;
  if (t.length <= 120 && SHARE_RE.test(t)) return 'share';
  if (t.length <= 80 && RELATED_LABEL_RE.test(t)) return 'related';
  if (t.length <= 60 && COMMENTS_RE.test(t)) return 'comments';
  if (t.length <= 220 && BOOKING_RE.test(t)) return 'booking';
  if (BOILERPLATE_RES.some((re) => re.test(t))) return 'boilerplate';
  if (t.length <= 150 && COPYRIGHT_RE.test(t) && !COPYRIGHT_WORDY_GUARD.test(t)) return 'copyright';
  return null;
}

// A headline line under a related-stories label: short, not a sentence end.
// Section words ("News", "Lifestyle") are short too, so they qualify.
function isHeadlineLine(t) {
  return t.length > 0 && t.length <= HEADLINE_MAX && !SENTENCE_END_RE.test(t);
}

/**
 * Analyse a body. Returns the lines (indexes into the split text) that are
 * furniture, with their category, plus the repeated paragraphs.
 */
function analyse(text) {
  const lines = String(text || '').split('\n');
  const norm = lines.map(normLine);
  const hits = new Map(); // index -> category
  const midBlock = new Set(); // related-story label + headlines sitting mid-article
  for (let i = 0; i < norm.length; i++) {
    if (hits.has(i)) continue;
    const t = norm[i];
    if (!t) continue;
    const cat = lineFurnitureCategory(t);
    if (!cat) continue;
    hits.set(i, cat);
    if (cat === 'related' && RELATED_BLOCK_RE.test(t)) {
      // Take the headline run below the label when real prose (a line ending
      // a sentence) follows it, i.e. the module sits mid-article, or when the
      // run reaches the end of the body. A run that stops at anything else
      // keeps its lines (only the label goes).
      let j = i + 1;
      let taken = 0;
      const run = [];
      while (j < norm.length && taken < HEADLINE_RUN_MAX) {
        const u = norm[j];
        if (!u) { j++; continue; }
        if (!isHeadlineLine(u)) break;
        run.push(j);
        taken++;
        j++;
      }
      while (j < norm.length && !norm[j]) j++;
      const proseFollows = j < norm.length && SENTENCE_END_RE.test(norm[j]) && norm[j].length >= 60;
      if (proseFollows) {
        midBlock.add(i);
        for (const k of run) { hits.set(k, 'related'); midBlock.add(k); }
      } else if (j >= norm.length) {
        // The module closes the body: label plus headlines to the end.
        for (const k of run) hits.set(k, 'related');
      }
    }
  }
  // Paragraphs the page printed twice (pull quotes, photo captions, a bio
  // block, the whole article twice). Keep the first, drop the rest.
  const seen = new Set();
  for (let i = 0; i < norm.length; i++) {
    const t = norm[i];
    if (t.length < REPEAT_MIN || hits.has(i)) continue;
    if (seen.has(t)) hits.set(i, 'repeat');
    else seen.add(t);
  }
  return { lines, hits, midBlock };
}

/**
 * Detector for the survey and the class-guard test.
 * @returns {{category: string, line: string}[]}
 */
function detectPageFurniture(text) {
  if (!text || typeof text !== 'string') return [];
  const { lines, hits } = analyse(text);
  return [...hits.entries()].sort((a, b) => a[0] - b[0]).map(([i, category]) => ({ category, line: normLine(lines[i]) }));
}

/**
 * Remove furniture lines (and whitespace-only lines left around them).
 * Returns the input unchanged (same string) when nothing is furniture.
 */
function stripPageFurniture(text, { tailGuard = false } = {}) {
  if (!text || typeof text !== 'string' || !pageFurnitureEnabled()) return text;
  const { lines, hits, midBlock } = analyse(text);
  if (tailGuard) {
    // First pass, ahead of stripTrailingJunk's cut-to-end patterns. Those
    // anchor on end-of-article lines (a copyright line, a trailing "Related
    // Stories" label, a newsletter prompt) and take everything below them,
    // so this pass leaves every such anchor in place and removes only what
    // can never be one: share tokens, comment counts, ticket widgets,
    // repeated paragraphs and related-story blocks sitting mid-article. The
    // full pass after the core takes the rest.
    for (const [i, cat] of [...hits.entries()]) {
      const keep = TAIL_GUARD_REMOVES.has(cat) || (cat === 'related' && midBlock.has(i));
      if (!keep) hits.delete(i);
    }
  }
  if (!hits.size) return text;
  const kept = lines.filter((_, i) => !hits.has(i));
  const out = kept.join('\n')
    .replace(/[^\S\n]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Never return an empty body: a text that is all furniture is a junk fetch
  // for the tier classifier to judge, not something to blank here.
  return out ? out : text;
}

module.exports = {
  stripPageFurniture,
  detectPageFurniture,
  lineFurnitureCategory,
  pageFurnitureEnabled,
};
