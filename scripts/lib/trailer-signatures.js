/**
 * trailer-signatures.js — the known page trailers that follow a review's last
 * paragraph and are not review prose, shared by two readers that must agree:
 *
 *   - content-quality.js stripVenueListingsTrailer(): the ending-punctuation
 *     check. It reads the text, never changes the stored copy, and rebuild
 *     re-tiers every file on each run, so adding a signature here upgrades
 *     false "truncated" files at the next rebuild with no rewrite.
 *   - text-cleaning.js stripTrailingJunk(): removes the same trailer from text
 *     being collected, so new files are stored without it.
 *
 * Why this exists: 1,768 files were tiered "truncated" only for
 * `Missing proper ending or other signals` (zero-gap plan, section 0). The
 * Guardian alone has 245, every one ending `• At the Almeida, London, until 7
 * June`. The review is whole; the listing line has no full stop.
 *
 * Every function is pure and conservative: a trailer goes only when the text
 * before it ends a sentence, the trailer is short, and (for the outlet-scoped
 * ones) the outlet is named. A review cut off mid-sentence right before a
 * trailer keeps its truncated verdict.
 */

'use strict';

const SENTENCE_END_RE = /[.!?]["'”’)]?$/;
const BULLET_RE = /[•·]/;

// ---------------------------------------------------------------------------
// UK listing bullets (Guardian, Observer): "... end of review. • At the
// Almeida, London, until 7 June", "• Until 12 October", "• 1984 continues at
// Her Majesty's Theatre until 27 May, before touring to ...", "• This article
// was amended on 22 December 2022 to ...". The trailer is one or more bullets.
// ---------------------------------------------------------------------------
const UK_TRAILER_MAX = 700;
const UK_SEGMENT_MAX = 260;
const UK_LISTING_CUE_RE = /^(?:At|Until|Touring|On tour)\b|\b(?:until|touring|continues|is at|is on|are at|are on|runs at|runs until|runs to|to \d{1,2} [A-Z][a-z]+|from \d{1,2} [A-Z][a-z]+)\b/;
const UK_AMENDED_NOTE_RE = /^This (?:article|review|piece) was (?:amended|corrected|updated)\b/;

const UK_LISTING_OPENER_RE = /^(?:At\s+(?:the\s+)?[\p{Lu}\d]|Until\s+[\p{Lu}\d]|Touring\b|On tour\b|Then touring\b|[\p{Lu}\d][^,.]{0,80}?\s(?:continues|runs|is|are|plays)\s(?:at|until|on|to)\b)/u;

function isUkTrailerSegment(seg) {
  if (!seg || seg.length > UK_SEGMENT_MAX) return false;
  if (UK_AMENDED_NOTE_RE.test(seg)) return true; // a correction note is prose, but never review prose
  // A listing has no sentence in it; one full stop at the very end is fine.
  // "At Crucible, Sheffield, until 7 February. Then touring" is one listing.
  const body = seg.replace(/\.$/, '').replace(/\.\s+(?=Then\b)/g, ', ');
  if (/[.!?]/.test(body.replace(/\b(?:St|Mr|Mrs|Dr)\./g, ''))) return false;
  // A listing opens like one ("At <Venue>", "Until <date>", "<Title> continues at ..."),
  // not like review prose that happens to contain "until 7 June" ("At the interval the actor ...").
  return UK_LISTING_OPENER_RE.test(body) && UK_LISTING_CUE_RE.test(body);
}

// The same listing with the bullet lost in extraction: "... the end. At Theatre
// Royal Haymarket, London, until 3 August" or "Antigone Exits runs at the Minerva
// theatre, Chichester, until 17 October". Stricter than the bulleted form because
// nothing marks where the trailer starts: it must be the whole last sentence,
// open with "At"/"Until"/"<Title> runs|continues|is|are", and name a date.
const UK_BARE_LISTING_START_RE = /^(?:(?:At|Until)\s|[A-Z][\w'’:&-]*(?:\s[\w'’:&-]+){0,8}\s(?:runs|continues|is|are|plays)\s(?:at|until|on|to)\s)/;
const UK_DATE_RE = /\b(?:until|to|from)\s+\d{1,2}\s+[A-Z][a-z]{2,8}\b|\buntil\s+(?:[A-Z][a-z]+day|[A-Z][a-z]{2,8}\s+\d{1,2})\b/;

// A finished listing ends on its date (or a "Then touring [to X]" tail), never on a
// dangling word: "At the interval the cast play on until 7 June with" is a review
// cut off mid-sentence and must stay truncated.
const UK_BARE_END_RE = /(?:\d{1,2}\s+[A-Z][a-z]{2,8}(?:,?\s+\d{4})?|\b[A-Z][a-z]+day|[A-Z][a-z]{2,8}\s+\d{1,2}|\b[Tt]ouring(?:\s+(?:to|in)\s+[A-Z][\w'’-]*(?:,?\s+[A-Z][\w'’-]*){0,4})?)\.?$/;

function stripBareUkListing(t) {
  const base = Math.max(0, t.length - 300);
  const tail = t.slice(base);
  // Try each sentence boundary in the tail, earliest first: the listing may be
  // two sentences ("... until 7 February. Then touring").
  const boundary = /([.!?]["'”’)]?)\s+/g;
  let m;
  while ((m = boundary.exec(tail)) !== null) {
    const frag = tail.slice(m.index + m[0].length).trim();
    if (frag.length < 8 || frag.length > UK_SEGMENT_MAX) continue;
    if (/[•·]/.test(frag)) continue;
    if (!UK_BARE_LISTING_START_RE.test(frag) || !UK_DATE_RE.test(frag) || !UK_BARE_END_RE.test(frag) || !isUkTrailerSegment(frag)) continue;
    return t.slice(0, base + m.index + m[1].length);
  }
  return t;
}

function stripUkListingBullets(text) {
  if (!text || typeof text !== 'string') return text;
  const t = text.replace(/\s+$/, '');
  const bare = stripBareUkListing(t);
  if (bare !== t) return bare;
  const from = Math.max(0, t.length - UK_TRAILER_MAX);
  let at = from;
  while (true) {
    const m = BULLET_RE.exec(t.slice(at));
    if (!m) return text;
    const idx = at + m.index;
    at = idx + 1;
    const before = t.slice(0, idx).replace(/\s+$/, '');
    // Whitespace must separate the sentence end from the bullet.
    if (before.length === idx || !SENTENCE_END_RE.test(before)) continue;
    const segs = t.slice(idx).split(BULLET_RE).map((s) => s.trim()).filter(Boolean);
    // The last segment must be finished (ends on a date, a touring tail, a sentence
    // end or is a correction note): "• At the interval the cast continues to sing and"
    // is a review cut off inside a bullet, not a listing.
    const last = segs[segs.length - 1] || '';
    const finished = UK_BARE_END_RE.test(last) || UK_AMENDED_NOTE_RE.test(last) || /[.!?]["'”’)]?$/.test(last);
    if (segs.length && finished && segs.every(isUkTrailerSegment)) return before;
  }
}

// ---------------------------------------------------------------------------
// thefourthwalsh: the review is followed by a production-info block that ends
// in the site footer. All 112 corpus files with the footer carry the block
// starting at "Running Time:" (longest 801 chars):
//   Running Time: ... At <venue> ... Performances are: ... For more information
//   or tickets Production photos by X For more Chicago theatre information and
//   reviews, please visit Theatre in Chicago Facebook --> Share on:
// ---------------------------------------------------------------------------
const FOURTHWALSH_BLOCK_RE = /\s*Running Time:[\s\S]{0,1100}?For more Chicago theatre information and reviews, please visit Theatre in Chicago(?:\s*Facebook\s*-->)?(?:\s*Share on:)?\s*$/;
// The footer alone: the sentence is unique to this site, so it is safe for any outlet.
const FOURTHWALSH_FOOTER_RE = /\s*For more Chicago theatre information and reviews, please visit Theatre in Chicago(?:\s*Facebook\s*-->)?(?:\s*Share on:)?\s*$/;

function stripFourthWalshInfoBlock(text) {
  if (!text || typeof text !== 'string') return text;
  const m = FOURTHWALSH_BLOCK_RE.exec(text);
  if (!m) return text;
  const before = text.slice(0, m.index).replace(/\s+$/, '');
  // Only when a whole review sits in front of the block.
  return SENTENCE_END_RE.test(before) && before.length >= 400 ? before : text;
}

// ---------------------------------------------------------------------------
// one-minute-critic: after the verdict line the page lists related-post
// headlines, one paragraph each ("Books - In 'X,' falling apart is just the
// beginning"). They carry no final full stop. Needs 2+ trailing headline
// paragraphs after a paragraph that ends a sentence, so a review that merely
// ends on one short paragraph is not touched.
// ---------------------------------------------------------------------------
const HEADLINE_MAX = 240;
const RELATED_MIN_REMAINING = 600;

function stripRelatedPostHeadlines(text) {
  if (!text || typeof text !== 'string') return text;
  const trimmed = text.replace(/\s+$/, '');
  const paras = trimmed.split(/\n\s*\n/);
  let k = paras.length;
  while (k > 1) {
    const p = paras[k - 1].trim();
    if (!p || p.length > HEADLINE_MAX || SENTENCE_END_RE.test(p)) break;
    k--;
  }
  const headlines = paras.length - k;
  if (headlines < 2 || k < 1) return text;
  // A final paragraph that stops on a function word is a cut-off review, not a headline.
  if (/\b(?:to|and|or|but|the|a|an|of|in|on|with|for|that|which|as|at|by|from|is|was)$/i.test(paras[paras.length - 1].trim())) return text;
  const body = paras.slice(0, k).join('\n\n').replace(/\s+$/, '');
  if (!SENTENCE_END_RE.test(body) || body.length < RELATED_MIN_REMAINING) return text;
  return body;
}

// ---------------------------------------------------------------------------
// Guardian/Observer API-era footer: "... Explore more on these topics Theatre
// Musicals reviews Share Reuse this content". The sentence is unique to the
// Guardian CMS, so it is safe for any outlet; 274 corpus files carry it.
// ---------------------------------------------------------------------------
const GUARDIAN_TOPICS_FOOTER_RE = /\s*Explore more on these topics[\s\S]{0,260}?Share\s+Reuse this content\s*$/;

function stripGuardianTopicsFooter(text) {
  if (!text || typeof text !== 'string') return text;
  const m = GUARDIAN_TOPICS_FOOTER_RE.exec(text);
  return m ? text.slice(0, m.index) : text;
}

// ---------------------------------------------------------------------------
// The Stage: the subscriber page ends with the critic's bio, one short
// paragraph with no final full stop ("Dave is a playwright and critic. He was
// the winner of The Stage's Critic Search 2015"). BRO-7171 Stage 4: 21
// complete Stage reviews read as truncated because of it. Only a short final
// paragraph that opens "<Name> is a/an ..." and names a writing job, after a
// body that ends a sentence and is review-length.
// ---------------------------------------------------------------------------
const STAGE_BIO_RE = /\s{2,}([A-Z][\w'’-]+(?: [A-Z][\w'’-]+)? is (?:a|an) [^\n]{0,360})$/;
const STAGE_BIO_JOB_RE = /\b(?:critic|writer|journalist|reviewer|playwright|editor|dramaturg)\b/i;

function stripStageCriticBio(text) {
  if (!text || typeof text !== 'string') return text;
  const t = text.replace(/\s+$/, '');
  const m = STAGE_BIO_RE.exec(t);
  if (!m || !STAGE_BIO_JOB_RE.test(m[1])) return text;
  const body = t.slice(0, m.index).replace(/\s+$/, '');
  return SENTENCE_END_RE.test(body) && body.length >= RELATED_MIN_REMAINING ? body : text;
}


// BRO-7569: the rest of The Stage's page tail. 27 of 31 still-"truncated" 2025-26
// Stage reviews held the whole review (the authenticated page was byte-equal to
// the stored text); their endings were, in some order after the last sentence:
//   "... end of review. For all the latest reviews from The Stage, sign up to our weekly reviews newsletter here"
//   "... For all the latest from the Edinburgh Fringe, sign up to The Stage’s Edinburgh newsletter"
//   "... Glasgow, then at Traverse Theatre , Edinburgh, November 6-8"  (run listing, own line)
//   "... Dave is a playwright and critic. He was the winner of ... 2015 Invest in The Stage today with a subscription starting at just £7.99"
// Layers are peeled from the end (promo, newsletter, bio, run listing, in any
// order) and the result is used only when what is left ends a sentence and is
// review-length, so a review cut off mid-sentence in front of them stays truncated.
const STAGE_PROMO_RE = /\s*Invest in The Stage today with a subscription[^\n]{0,60}$/;
const STAGE_NEWSLETTER_RE = /\s*For all the latest [^\n]{0,80}?sign up to [^\n]{0,80}?newsletter(?: here)?\.?\s*$/i;
const STAGE_RUN_LISTING_RE = /\n\s*[\p{Lu}][^\n.]{1,80}?,\s+then\s+(?:then\s+)?(?=[^\n]*\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b[^\n]*\d|[^\n]*\d[^\n]*\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b|[^\n]*\b(?:until|from|Theatre|Playhouse|Hall|Centre|Rep)\b)[^\n.]{1,120}$/u;
// a cut-off sentence ends on a function word; a real bio or listing never does
const STAGE_CUTOFF_END_RE = /\b(?:the|a|an|and|or|of|to|in|on|at|by|for|with|but|that|this|how|as|from|his|her|their|its|is|was)\s*$/i;
const STAGE_BIO_ANY_RE = /(?:\n\s*|\s{2,})((?!(?:It|This|That|There|He|She|They)\b)[A-Z][\w'’-]+(?: [A-Z][\w'’-]+)? is (?:a|an|the) [^\n]{0,360}?)$/;

const STAGE_BIO_SPACE_RE = /(?<=[.!?]["'”’]?)\s((?!(?:It|This|That|There|He|She|They)\b)[A-Z][\w'’-]+(?: [A-Z][\w'’-]+)? (?:is|was) (?:a|an|the) [^\n]{0,360}?)$/;

function stripStagePageTail(text) {
  if (!text || typeof text !== 'string') return text;
  let t = text.replace(/\s+$/, '');
  let peeled = false;
  let promoSeen = false;
  for (let i = 0; i < 6; i++) {
    let n = t.replace(STAGE_PROMO_RE, '');
    if (n !== t) promoSeen = true;
    if (n === t) n = t.replace(STAGE_NEWSLETTER_RE, '');
    if (n === t) n = t.replace(STAGE_RUN_LISTING_RE, '');
    if (n === t) {
      // bio: a short last sentence run that names a writing job and is not review prose
      // a bio set off by one space is accepted only when the page's subscription promo followed it
      const m = STAGE_BIO_ANY_RE.exec(t) || (promoSeen ? STAGE_BIO_SPACE_RE.exec(t) : null);
      if (m && STAGE_BIO_JOB_RE.test(m[1]) && !STAGE_CUTOFF_END_RE.test(m[1]) && !/[.!?]["'”’]?\s+[A-Z]/.test(m[1].replace(/^[^.]*\.\s+(?=(?:He|She|They)\b)/, ''))) n = t.slice(0, m.index);
    }
    if (n === t) break;
    t = n.replace(/\s+$/, '');
    peeled = true;
  }
  if (!peeled) return text;
  return SENTENCE_END_RE.test(t) && t.length >= RELATED_MIN_REMAINING ? t : text;
}

// ---------------------------------------------------------------------------
// The Times / Sunday Times: the review ends with a listing footer, then often a
// promo line. Real endings (BRO-7171 Stage 4, times-uk live batch: 12 of 20
// "truncated" files already held the whole review):
//   "... tightens the noose. ★★★★☆ Ambassadors Theatre, London, to Aug 1, theambassadorstheatre.co.uk 110min"
//   "... Not while we have Beverlys.★★★★☆120minTo October 12, stratfordeast.com\n\nFollow @timesculture to read the latest reviews"
//   "... How British is that?Box office: 020 7565 5000, royalcourttheatre.com, to November 16\n\nSave ... Promoted Content"
//   "... ★★☆☆☆ London Coliseum, to Dec 11, eno.org\n\nLove classical music and opera? Get access to ... Facebook group"
// Promo lines go first; then a short footer that opens with a star rating,
// "Box office:" or "To <Month> <day>" and carries a domain, a run date or the
// stars. Stripped only when what precedes it ends a sentence and is review-length.
// ---------------------------------------------------------------------------
const TIMES_PROMO_RE = /\s*(?:Follow @timesculture[^\n]{0,80}|Save\b[\s\S]{0,40}?Promoted Content|Promoted Content|What have you enjoyed at the theatre recently\?[^\n]{0,120}|Love classical music and opera\?[^\n]{0,160})\s*$/;
const TIMES_FOOTER_START_RE = /★|Box office:|\bTo (?:[A-Z][a-z]{2,8} \d{1,2}|\d{1,2} [A-Z][a-z]{2,8})\b/g;
const TIMES_FOOTER_MAX = 240;
const TIMES_FOOTER_EVIDENCE_RE = /★|\b[a-z0-9-]+\.(?:co\.uk|org\.uk|com|org|net|london|uk)\b|\b[Tt]o (?:[A-Z][a-z]{2,8} \d{1,2}|\d{1,2} [A-Z][a-z]{2,8})\b/;

function stripTimesFooter(text) {
  if (!text || typeof text !== 'string') return text;
  let t = text.replace(/\s+$/, '');
  for (let i = 0; i < 3; i++) {
    const p = t.replace(TIMES_PROMO_RE, '');
    if (p === t) break;
    t = p;
  }
  const from = Math.max(0, t.length - TIMES_FOOTER_MAX);
  TIMES_FOOTER_START_RE.lastIndex = from;
  let m;
  while ((m = TIMES_FOOTER_START_RE.exec(t)) !== null) {
    const footer = t.slice(m.index);
    const body = t.slice(0, m.index).replace(/\s+$/, '');
    // the footer is a listing, not prose: no full sentence inside it
    const prose = /[a-z]{2,}[.!?]["'”’]?\s+[A-Z][a-z]+ [a-z]+ [a-z]+/.test(footer);
    if (!prose && TIMES_FOOTER_EVIDENCE_RE.test(footer) && SENTENCE_END_RE.test(body) && body.length >= RELATED_MIN_REMAINING) return body;
  }
  return t === text.replace(/\s+$/, '') ? text : (SENTENCE_END_RE.test(t) && t.length >= RELATED_MIN_REMAINING ? t : text);
}

// ---------------------------------------------------------------------------
// The Telegraph / Sunday Telegraph: the review ends with a listing line, often
// followed by a box-office promo. Real endings (BRO-7171 Telegraph trial run
// 2026-11-11: 5 of 10 "truncated" files already held the whole review):
//   "... far greater.\n\nLyric Hammersmith, London W6 ( lyric.co.uk ) until October 3"
//   "... I can’t say I enjoyed it.\n\nUntil Jun 6. Tickets: 020 3989 5455; nationaltheatre.org.uk"
//   "... narrative theatre at its very best.\n\nAt Royal Lyceum until Oct 18, then touring until Nov 7; book tickets"
//   "... the silence seems to scream.\n\nWyndham’s, to Apr 13; www.quartermainesterms.com\n\nTelegraph Boxoffice Popular Shows»"
// Promo lines go first; then the last fragment after a sentence end, when it
// opens like a listing, carries a run date / phone / domain / "Tickets", has
// no prose sentence in it, and what precedes it ends a sentence at review length.
// ---------------------------------------------------------------------------
// Second wave (2026-11-11 batch 4: 14 files whose live page held exactly our
// text still read truncated): the 2010-12 box-office link is split over lines
// ("Buy tickets to\n\nBlithe Spirit\n\nwith\n\nTelegraph Box Office", "Buy\n\n
// Frankenstein Tickets\n\nfrom\n\nTelegraph Tickets"), Seven magazine adds a
// "Follow SEVEN on Twitter" line, and 2017 reviews end "Book your tickets now
// to avoid disappointment at tickets.telegraph.co.uk or by calling: 0844 871 2118".
const TELEGRAPH_PROMO_RE = /[\s​]*(?:Telegraph Box ?office Popular Shows»|Twitter Icon Facebook Icon WhatsApp Icon Email Icon Comment speech bubble|Buy [^\n]{0,80}?tickets[^\n]{0,80}?Telegraph Box Office\.?|(?<=^|\n)\s*Buy\b[\s\S]{0,80}?\btickets\b[\s\S]{0,40}?\bTelegraph (?:Box Office|Tickets)\.?|Book tickets via Tickets \| Telegraph Media Group provided by London Theatre Direct(?:\s+Recommended[^\n]{0,200}?Read more)?|This review also appears in Seven magazine[^\n]{0,80}|Follow SEVEN on Twitter @TelegraphSeven|Book your tickets[^\n]{0,60}? at tickets\.telegraph\.co\.uk or by calling:? 0\d{3} ?\d{3} ?\d{4})[\s​]*$/i;
const TELEGRAPH_FOOTER_MAX = 260;
// whole month words only: a bare "Mar"/"May" prefix matched "remark", "mayhem"
const TELEGRAPH_MONTH = '\\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\b\\.?';
// Each opener names what follows it, so a prose fragment that merely starts
// with "Until"/"Tickets"/"Book" ("Until the final scene, the") is not a listing
// (second review, 406b6a883f6).
const TELEGRAPH_DATE = `(?:${TELEGRAPH_MONTH}\\s+\\d{1,2}|\\d{1,2}\\s+${TELEGRAPH_MONTH})`;
const TELEGRAPH_OPENER_RE = new RegExp(`^(?:(?:Until|To)\\s+${TELEGRAPH_DATE}|Booking\\s+(?:to|until)\\s+${TELEGRAPH_DATE}|Book(?:ing)?\\s+tickets\\b|Tickets?(?::|\\s+\\d)|At\\s+(?:the\\s+)?\\p{Lu}|(?!(?:Then|But|And|So|Yet|It|He|She|They|We|I|There|Here|Still|Even|Now)\\b)[\\p{Lu}\\d][\\w'’&.-]*(?:\\s+[\\w'’&.()-]+){0,6},\\s+(?:London\\s+(?:[A-Z]{1,2}\\d{1,2}[A-Z]?\\b|\\()|(?:to|until)\\s+${TELEGRAPH_DATE}))`, 'u');
// later sentences of a listing ("... Tickets: 020 ...", "Purchase X tickets or call 0844 ...")
const TELEGRAPH_HARD_EVIDENCE_RE = /\b[a-z0-9-]+\.(?:co\.uk|org\.uk|com|org|net|london|uk)\b|\b0\d{2,4}\s?\d{3,4}\s?\d{3,4}\b|^Then touring\b/;
const TELEGRAPH_EVIDENCE_RE = new RegExp(`\\b(?:[Uu]ntil|to)\\s+(?:${TELEGRAPH_MONTH}\\s+\\d{1,2}|\\d{1,2}\\s+${TELEGRAPH_MONTH})|\\b[a-z0-9-]+\\.(?:co\\.uk|org\\.uk|com|org|net|london|uk)\\b|\\b0\\d{2,4}\\s?\\d{3,4}\\s?\\d{3,4}\\b|\\bTickets?:`);
// the listing ends on a date, a domain, a number or "book tickets", never on a dangling word
// (also a full box-office url, and the "; Telegraph Tickets" link text)
const TELEGRAPH_END_RE = new RegExp(`(?:\\d|${TELEGRAPH_MONTH}|\\.(?:co\\.uk|org\\.uk|com|org|net|london|uk)|\\bbook tickets|\\bTelegraph Tickets|https?://\\S+|\\))\\.?\\s*$`);

function stripTelegraphFooter(text) {
  if (!text || typeof text !== 'string') return text;
  let t = text.replace(/[\s​]+$/, '');
  let promo = false;
  for (let i = 0; i < 3; i++) {
    const p = t.replace(TELEGRAPH_PROMO_RE, '');
    if (p === t) break;
    t = p;
    promo = true;
  }
  const base = Math.max(0, t.length - TELEGRAPH_FOOTER_MAX - 5);
  const tail = t.slice(base);
  // a footer starts after a sentence end or a paragraph break
  const boundary = /[.!?]["'”’)]?\s+|\n\s*\n/g;
  let m;
  while ((m = boundary.exec(tail)) !== null) {
    const footer = tail.slice(m.index + m[0].length).trim();
    if (!isTelegraphListing(footer, promo)) continue;
    const body = t.slice(0, base + m.index + m[0].length).replace(/\s+$/, '');
    // the body must end a sentence, and that sentence must not itself be a
    // listing: "... a snarl\n\nUntil Jun 6. Tickets: ..." is a cut-off review
    // whose "Until Jun 6." would otherwise pass for its last sentence.
    if (!SENTENCE_END_RE.test(body) || body.length < RELATED_MIN_REMAINING) continue;
    const lastSeg = body.split(/[.!?]["'”’)]?\s+|\n\s*\n/).pop().trim();
    const lastBare = lastSeg.replace(/[.!?]["'”’)]?$/, '');
    // a short venue line with no date ("National Theatre, London SE1.") opens
    // like a listing too: it is not the review's last sentence either
    if (isTelegraphListing(lastBare) || (lastBare.length <= 120 && TELEGRAPH_OPENER_RE.test(lastBare))) continue;
    return body;
  }
  return t === text.replace(/\s+$/, '') ? text : (SENTENCE_END_RE.test(t) && t.length >= RELATED_MIN_REMAINING ? t : text);
}

// afterPromo: a box-office promo was just stripped, so the article ended there
// and the text is not cut off; a one-line "Harold Pinter Theatre, to Apr 14"
// needs no phone or domain to count as its listing then.
function isTelegraphListing(seg, afterPromo = false) {
  if (!seg || seg.length < 6 || seg.length > TELEGRAPH_FOOTER_MAX) return false;
  // a listing, not prose: no full sentence inside it
  if (/[a-z]{2,}[.!?]["'”’]?\s+[A-Z][a-z]+ [a-z]+ [a-z]+/.test(seg)) return false;
  if (!(TELEGRAPH_OPENER_RE.test(seg) && TELEGRAPH_EVIDENCE_RE.test(seg) && TELEGRAPH_END_RE.test(seg))) return false;
  // A run date alone is not enough ("In 1987, to Oct 18" is prose): a real
  // listing also carries a box-office domain, a phone number or the closing
  // "; book tickets" link (third review, 2026-11-11).
  // "; book tickets" is the link text after a listing; bare "book tickets" and a
  // postcode also occur in prose (fourth review), so neither counts alone.
  if (!(TELEGRAPH_HARD_EVIDENCE_RE.test(seg) || /;\s*book tickets$/.test(seg) || (afterPromo && !/[.!?;\n]/.test(seg)))) return false;
  // every later sentence must be listing too: an opener or a phone / domain
  const parts = seg.split(/(?<=[a-z0-9)])[.]\s+(?=[A-Z])/).slice(1);
  return parts.every((p) => TELEGRAPH_OPENER_RE.test(p) || TELEGRAPH_HARD_EVIDENCE_RE.test(p));
}

// Run-info / photo-credit page tail (BRO-7171, 2026-11-16), first measured on
// BroadwayWorld and found on ~37 other outlets: a run line ("X plays at the
// Garrick Theatre until 6 June"), a photo credit ("Photography Credit: Helen
// Murray", "All photos by ..."), a ticket line ("For tickets and more
// information, visit: ...") and the show widget ("Get InfoBuy TixCastPhotos...").
// None ends in sentence punctuation, so 75 of 177 open BWW gaps sat as
// TRUNCATED_OTHER and looped on a free refetch that BWW never answers; ~105
// more open gaps on other outlets end the same way. Classify-only for every
// outlet (stripKnownTrailers), never applied to saved text.
// Each piece is removed from the end only; prose before it must end a sentence.
// Isolated kill switch: RUN_INFO_TRAILER_DISABLED=true turns off only this
// stripper (TRAILER_FIXES_DISABLED still turns off the whole chain).
const BWW_WIDGET_RE = /(?<!\s)\s*(?:Get\s*Info\s*Buy\s*Tix|Get Show Info\s*\n)([\s\S]{0,300})$/;
const BWW_PHOTO_RE = /(?:^|\s)(?:All\s+)?(?:production\s+)?(?:photos?|photograph(?:s|y)|photo\s+images?|images?)\s*(?:credits?\s*:?|:|by\b|are\s+by\b|courtesy\s+of\b)([^.!?\n]{1,120})$/i;
// a ticket / "for information" line is furniture only with a link, a phone or
// a price, or a call to action in a line that ends its sentence; "Tickets are
// scarce here, and anyone ... will" is a cut-off review.
const TICKET_HARD_EVIDENCE_RE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|org|net|co\.uk|org\.uk|uk)\b|\(?\d{3}\)?[-.\s]\d{3}[-.\s]?\d{4}|\b0\d{3,4}\s?\d{3}\s?\d{3,4}\b|[$£]\s?\d/i;
// the last token itself is the link / domain / phone / price ("…; nationaltheatre.org.uk")
const TICKET_LAST_TOKEN_RE = /(?:https?:\/\/\S+|www\.\S+|\b[\w-]+\.(?:com|org|net|co\.uk|org\.uk|uk)\/?\S*|\d{3}[-.\s]?\d{4}|[$£]\s?[\d.,-]+|\d)["'”’)]?$/i;
const TICKET_CTA_RE = /\b(?:visit|visiting|click|call|website)\b|\bhere\b/i;
// the ticket line is the LAST sentence: a dot only inside a token (a url, "$59.50")
const BWW_TICKETS_RE = /(?:^|[.!?]["'”’)]?\s+|\n)((?:For\s+(?:more\s+)?(?:tickets?|ticket\s+and|information)\b|Tickets?\s*(?::|are\b|available\b|start\b)|Get\s+tickets\b)(?:[^.!?\n]|[.!?](?=[^\s"'”’)]))*[.!?]?["'”’)]?)$/i;
const BWW_RUN_SEG_RE = new RegExp(
  `(?:^|[.!?]["'”’)]?\\s+|\\n)((?:[^.!?\\n]|[!?](?=\\)))(?:[^.!?\\n]|[!?](?=\\))){2,199}?(?:\\b(?:until|through|thru|till)\\s+(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${TELEGRAPH_MONTH}|${TELEGRAPH_MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?)(?:,?\\s*\\d{4})?(?:\\s*(?:,|and)?\\s*then\\s+(?:on\\s+tour|touring|at\\s+\\p{Lu}[^.!?\\n]{0,60}))?|\\bRunning\\b[^.!?\\n]{0,40}${TELEGRAPH_MONTH}[^.!?\\n]{0,80}?))\\.?$`, 'u'
);
const RUN_DATE_RE = new RegExp(`\\b(?:until|through|thru|till)\\s+(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${TELEGRAPH_MONTH}|${TELEGRAPH_MONTH}\\s+\\d{1,2})`);
// a segment that ends on a joining / function word is a cut sentence, never furniture
const DANGLING_END_RE = /(?:\b(?:the|a|an|and|or|of|to|in|on|at|by|for|with|but|that|this|how|as|from|his|her|their|its|is|was|are|were|only|then|when|who|which|will|would|so)|[,&;:–—-])\s*$/i;
// lower-case words a names-only photo credit may carry
const CREDIT_LOWER_WORDS = new Set(['and', 'for', 'of', 'by', 'courtesy', 'via', 'provided', 'de', 'van', 'von', 'la', 'le', 'du', 'da']);

function namesOnly(seg) {
  const words = String(seg).split(/[\s,]+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
  if (!words.length || DANGLING_END_RE.test(seg)) return false;
  return words.every((w) => /^[\p{Lu}\p{N}]/u.test(w) || CREDIT_LOWER_WORDS.has(w.toLowerCase()));
}

function stripRunInfoTrailer(text) {
  if (!text || typeof text !== 'string') return text;
  if (process.env.RUN_INFO_TRAILER_DISABLED === 'true') return text;
  let t = text.trimEnd();
  for (let i = 0; i < 5; i++) {
    const before = t;
    // the show widget: only menu words after it, never prose
    const w = BWW_WIDGET_RE.exec(t);
    if (w && !/\b[a-z]{2,}\s+[a-z]{2,}\s+[a-z]{2,}\b/.test(w[1])) t = t.slice(0, w.index).trimEnd();
    // a photo credit is names only ("Photography by Helen Murray"), not
    // "Photos by Weegee line the walls of the set, and ..."
    const ph = BWW_PHOTO_RE.exec(t);
    if (ph && namesOnly(ph[1])) t = t.slice(0, ph.index).trimEnd();
    const tk = BWW_TICKETS_RE.exec(t);
    // ...and it ends its sentence or ends ON the link / phone / price
    const tkEnds = tk && (/[.!?]["'”’)]?$/.test(tk[1]) || TICKET_HARD_EVIDENCE_RE.test(tk[1].split(/\s+/).slice(-2).join(' ')) && TICKET_LAST_TOKEN_RE.test(tk[1]));
    if (tk && tkEnds && !DANGLING_END_RE.test(tk[1])
      && (TICKET_HARD_EVIDENCE_RE.test(tk[1]) || (TICKET_CTA_RE.test(tk[1]) && /[.!?]["'”’)]?$/.test(tk[1])))) {
      t = t.slice(0, tk.index + (tk[0].match(/^[.!?]["'”’)]?/) || [''])[0].length).trimEnd();
    }
    const run = BWW_RUN_SEG_RE.exec(t);
    // a run line names a venue ("at"/"in" before the date, or "Running ...")
    // and reads like a listing, not prose: see looksLikeListing
    if (run && /\b(?:at|in|Running)\b/.test(run[1]) && looksLikeListing(run[1]) && !DANGLING_END_RE.test(run[1])) {
      t = t.slice(0, run.index + (run[0].match(/^[.!?]["'”’)]?/) || [''])[0].length).trimEnd();
    }
    if (t === before) break;
  }
  if (t === text.trimEnd()) return text;
  if (!SENTENCE_END_RE.test(t) || t.length < RELATED_MIN_REMAINING) return text;
  // the sentence now last must not itself be a listing ("Until Jun 6." left
  // after its "Tickets: ..." line, "National Theatre, London SE1."): a cut
  // review can end on one. Same test the Telegraph stripper applies.
  const lastSeg = t.split(/[.!?]["'”’)]?\s+|\n/).pop().trim();
  const lastBare = lastSeg.replace(/[.!?]["'”’)]?$/, '');
  if (lastBare.length < 40 && new RegExp(TELEGRAPH_MONTH).test(lastBare)) return text;
  if (isTelegraphListing(lastBare) || (lastBare.length <= 120 && TELEGRAPH_OPENER_RE.test(lastBare))) return text;
  // "... a snarl Dog Mom is at the Southwark Playhouse until 7th November." is
  // a cut sentence glued to a run line: a run date in prose-shaped text.
  if (RUN_DATE_RE.test(lastBare) && !looksLikeListing(lastBare)) return text;
  return t;
}

// ---------------------------------------------------------------------------
// BRO-7942: furniture tail. About 1,107 TRUNCATED_OTHER / SHORT_UNVERIFIED rows
// were whole reviews ending in page furniture the chain above did not know:
// "It runs until 25 January 2026. Tickets: here. Review: Oliver Popa Photos:
// Mark Senior", "Until October 24 KilnTheatre.com", a Time Out social footer,
// "CLICK HERE TO READ MORE ARTICLES BY ...", leftover template code
// (`Δ document.getElementById("ak_js_1").setAttribute(...)`, gtag(...), mso css).
// Classify-only (stripKnownTrailers), never applied to saved text. Pieces come
// off the end one at a time; the prose that remains must end a sentence, keep
// RELATED_MIN_REMAINING chars, and must not itself end on a listing.
// Kill switch: FURNITURE_TAIL_DISABLED=true.
// ---------------------------------------------------------------------------
const FURN_DATE = `(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${TELEGRAPH_MONTH}|${TELEGRAPH_MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?)`;
const FURN_NAMES = "((?:[\\p{Lu}][\\p{L}'’.-]*|&|and|de|van|von|la|le|du|da)(?:\\s*,?\\s*(?:[\\p{Lu}][\\p{L}'’.-]*|&|and|de|van|von|la|le|du|da)){0,7})";
// Template / script residue: never prose, so the whole tail goes.
const FURN_CODE_RES = [
  /\s*Δ\s*document\.getElementById\([\s\S]*$/,
  /\s*(?:window\.)?dataLayer\s*=\s*window\.dataLayer[\s\S]*$/,
  /\s*@page\s+WordSection\d[\s\S]*$/,
  /\s*(?:\/\*[\s\S]{0,40})?(?:mso-[a-z-]+\s*:[^;]{0,60};\s*){2,}[\s\S]{0,2500}$/,
  /\s*css:\s*\{[\s\S]{0,300}$/,
];
// Boilerplate footers, whole tail.
const FURN_FOOTER_RES = [
  /\s*(?:Keep up with the latest news and reviews on our Time Out Theater Facebook page|Follow Time Out Theater on (?:Facebook|X|Twitter|Instagram))[\s\S]{0,300}$/,
  /\s*(?:Editor['’]s Note:\s*)?Click here to read more Picture this Post (?:stories|articles) by [^.\n]{1,60}\.?$/i,
  /\s*CLICK HERE TO READ MORE ARTICLES BY [A-Z][A-Z .'’-]{2,50}\.?$/,
  /\s*For more shows visit Theatre in Chicago(?:\s*Facebook\s*-->)?(?:\s*Share on:)?$/,
  /\s*\|\s*Image:\s*[^|\n]{1,80}$/,
  /\s*To learn more about [\p{Lu}][\p{L} .'’-]{2,40} and his reviews, click here to go to his website\.?$/u,
  /\s*(?:For further information or to book )?visit the theatre['’]s website here\s*\.?(?:\s*Related Items[^\n]{0,80})?$/i,
  /\s*Watch (?:the trailer|some behind-the-scenes footage|the video)[^.!?\n]{0,120}? here\s*:?(?:\s*Related Items[^\n]{0,80})?$/i,
  /\s*(?:For more reviews see TheatreInChicago\.com\s*)?Tags:\s[^\n]{0,300}$/,
  /\s*(?:•|·)\s*(?:Did you catch this show|What have you been to see lately)[^\n]{0,200}$/,
  /\s*Running time:\s*$/,
];
// One short piece at the very end. Names-only credits keep a cut sentence ("Photos by Weegee line ...") out.
const FURN_TICKETS_RE = /(?:^|\s)Tickets?:\s*(?:here|click here|link|https?:\/\/\S+|www\.\S+)\.?$/i;
const FURN_CREDIT_RE = new RegExp(`(?:^|\\s|\\||(?<=[\\p{L}\\d.!?]))(?:Review(?:ed)?(?:\\s+by)?\\s*:|(?:Review(?:ed)?\\s+)?by\\s*:|(?:Photos?|Photography|Photograph|Images?)(?:\\s+credits?)?\\s*(?::|\\bby\\b)|(?:Photo|Image)\\s+credits?\\s*:?)\\s*(?:courtesy\\s+of\\s+)?${FURN_NAMES}\\s*$`, 'iu');
const FURN_RUNS_RE = new RegExp(`(?:^|\\s|\\||(?<=[.!?]))(?:(?:It|The\\s+(?:show|production|run))\\s+)?(?:runs|continues|plays|booking|books|bookings?)\\s+(?:until|through|thru|to)\\s+(?:${FURN_DATE})(?:,?\\s*\\d{4})?\\.?\\s*$`, 'iu');
// "Until October 24 KilnTheatre.com", "Until Jan 31", "Details: Midnight, to January 3": a bare run line, only after a sentence end.
const FURN_BARE_UNTIL_RE = new RegExp(`(?:^|[.!?]["'”’)]?\\s+)(?:Details:\\s*[^.!?\\n]{0,40}?,?\\s*)?(?:Until|To|Through|Runs until)\\s+(?:${FURN_DATE})(?:,?\\s*\\d{4})?(?:,?\\s*[\\p{Lu}][^.!?\\n]{1,60}?(?=\\s*\\([\\d ]{8,16}\\)\\.?\\s*$))?(?:,?\\s+[\\w.-]+\\.(?:com|org|net|co\\.uk|org\\.uk|uk)|\\s*\\([\\d ]{8,16}\\))?\\.?\\s*$`, 'u');
// A Time Out capsule's credits: "Public Theater (Off Broadway). By X. Directed by Y. With ensemble cast. Running time:"
const FURN_TIMEOUT_CREDITS_RE = /(?:^|[.!?]["'”’)]?\s+|\n)[\p{Lu}][^.!?\n]{2,70}\((?:Off[- ])?Broadway\)\.\s+By\s[^.!?\n]{1,80}\.\s+Directed by\s[^.!?\n]{1,80}\.(?:\s+(?:With|Starring)\s[^.!?\n]{1,200}\.)?(?:\s+Running time:[^.!?\n]{0,60}\.?)?(?:\s+(?:One|Two|No)\s+intermissions?\.?)?\s*$/u;

// Time Out running-time line, optionally closed by its run date: "Running time: 1hr 25mins. No intermission. Through July 23."
const FURN_RUNNING_TIME_RE = new RegExp(`(?:^|[.!?]["'”’)]?\\s+)Running time:\\s*[^.!?\\n]{1,40}\\.(?:\\s+(?:One|Two|No)\\s+intermissions?\\.)?(?:\\s+(?:Through|Until)\\s+(?:${FURN_DATE})(?:,?\\s*\\d{4})?\\.?)?\\s*$`, 'u');

// A match may start on the sentence end it follows ([.!?] + space): the cut keeps that punctuation.
const cutOf = (m) => m.index + ((m[0].match(/^[.!?]["'”’)]?/) || [''])[0].length);

function furnitureMatch(t) {
  for (const re of FURN_CODE_RES) { const m = re.exec(t); if (m) return { cut: cutOf(m), code: true }; }
  for (const re of FURN_FOOTER_RES) { const m = re.exec(t); if (m) return { cut: cutOf(m), code: false }; }
  const tk = FURN_TICKETS_RE.exec(t);
  if (tk) return { cut: cutOf(tk), code: false };
  const cr = FURN_CREDIT_RE.exec(t);
  if (cr && !DANGLING_END_RE.test(cr[1]) && namesOnly(cr[1])) return { cut: cutOf(cr), code: false };
  const rn = FURN_RUNS_RE.exec(t);
  if (rn) return { cut: cutOf(rn), code: false };
  const bu = FURN_BARE_UNTIL_RE.exec(t);
  if (bu) return { cut: cutOf(bu), code: false };
  const rt = FURN_RUNNING_TIME_RE.exec(t);
  if (rt) return { cut: cutOf(rt), code: false };
  const tc = FURN_TIMEOUT_CREDITS_RE.exec(t);
  if (tc) return { cut: cutOf(tc), code: false };
  return null;
}

function stripFurnitureTail(text) {
  if (!text || typeof text !== 'string') return text;
  if (process.env.FURNITURE_TAIL_DISABLED === 'true') return text;
  let t = text.trimEnd();
  const orig = t;
  for (let i = 0; i < 10; i++) {
    const m = furnitureMatch(t);
    if (!m) break;
    const next = t.slice(0, m.cut).trimEnd();
    // a short piece only (code and footers may be longer, they are fenced by their own regexes)
    if (!m.code && t.length - next.length > 400) break;
    // template code is never prose: a tail holding a run of plain words is a review, not residue
    if (m.code && /(?:\b[a-z]{2,}\b\s+){12}/.test(t.slice(next.length))) break;
    if (next.length < RELATED_MIN_REMAINING) break;
    t = next;
  }
  if (t === orig) return text;
  if (!SENTENCE_END_RE.test(t)) return text;
  const lastBare = t.split(/[.!?]["'”’)]?\s+|\n/).pop().trim().replace(/[.!?]["'”’)]?$/, '');
  if (lastBare.length < 40 && new RegExp(TELEGRAPH_MONTH).test(lastBare)) return text;
  return t;
}

// Words a listing line carries in lower case; every other word in a run line
// is a title or venue (capitalised) or a number. Prose that happens to end
// "... and the lead is at the Garrick until 7 June" is mostly lower case.
const LISTING_LOWER_WORDS = new Set(['the', 'a', 'an', 'at', 'in', 'on', 'of', 'and', 'to', 'until', 'through', 'thru', 'till', 'runs', 'run', 'running', 'plays', 'play', 'playing', 'is', 'are', 'will', 'be', 'now', 'then', 'from', 'for', 'tour', 'touring', 'booking', 'with', 'currently', 'continues', 'performs', 'them', 'it', 'its', 'open', 'bookings']);
function looksLikeListing(seg) {
  const words = String(seg).split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
  let caps = 0;
  let other = 0;
  for (const w of words) {
    if (/^\p{N}/u.test(w) || LISTING_LOWER_WORDS.has(w.toLowerCase())) continue;
    if (/^\p{Lu}/u.test(w)) caps++; else other++;
  }
  return caps >= 1 && other <= 1 && caps >= 2 * other;
}

// Outlet-scoped strippers (outletId is the registry id on the review file).
const OUTLET_TRAILER_STRIPPERS = Object.freeze({
  'times-uk': stripTimesFooter,
  'sunday-times': stripTimesFooter,
  telegraph: stripTelegraphFooter,
  'sunday-telegraph': stripTelegraphFooter,
  thestage: stripStageCriticBio,
  'one-minute-critic': stripRelatedPostHeadlines,
  thefourthwalsh: stripFourthWalshInfoBlock,
});

// Strippers that only feed the tier classifier and never edit saved text: the
// Times footer carries the star rating (★★★★☆), the scorer's band anchor.
// The Telegraph footer is classify-only too: the saved text stays as fetched.
const CLASSIFY_ONLY_OUTLETS = Object.freeze(new Set(['times-uk', 'sunday-times', 'telegraph', 'sunday-telegraph']));

/**
 * Strip the trailer known for this outlet; unknown outlet returns text unchanged.
 * @param {{forClassify?: boolean}} [opts] forClassify also runs the classify-only
 *   strippers; the save path (stripTrailingJunk) leaves it off.
 */
function stripOutletTrailer(text, outletId, { forClassify = false } = {}) {
  // BRO-7569: the wider Stage page tail (promo, newsletter, run listing) only feeds the
  // classifier; the saved text keeps its pre-existing bio-only strip.
  if (forClassify && outletId === 'thestage') return stripStagePageTail(text);
  const fn = outletId && OUTLET_TRAILER_STRIPPERS[outletId];
  if (!fn) return text;
  if (!forClassify && CLASSIFY_ONLY_OUTLETS.has(outletId)) return text;
  return fn(text);
}

/**
 * Kill switch and dry-run seam: TRAILER_FIXES_DISABLED=true restores the
 * pre-fix classifier (no trailer stripping, ASCII-only ending class). The
 * false-truncation dry-run runs the classifier both ways to attribute every
 * tier change to this fix.
 */
function trailerFixesEnabled() {
  return process.env.TRAILER_FIXES_DISABLED !== 'true';
}

/** Every known trailer, for the ending-punctuation check. */
function stripKnownTrailers(text, outletId) {
  if (!trailerFixesEnabled()) return text;
  return stripFurnitureTail(stripRunInfoTrailer(stripOutletTrailer(stripUkListingBullets(stripGuardianTopicsFooter(text)), outletId, { forClassify: true })));
}

module.exports = {
  stripUkListingBullets,
  stripFourthWalshInfoBlock,
  stripRelatedPostHeadlines,
  stripStageCriticBio,
  stripStagePageTail,
  stripTimesFooter,
  stripTelegraphFooter,
  stripRunInfoTrailer,
  stripFurnitureTail,
  stripGuardianTopicsFooter,
  stripOutletTrailer,
  stripKnownTrailers,
  trailerFixesEnabled,
  FOURTHWALSH_FOOTER_RE,
  OUTLET_TRAILER_STRIPPERS,
};
