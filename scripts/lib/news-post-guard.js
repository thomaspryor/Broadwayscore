'use strict';
/**
 * News-post guard for URL ingest (BRO-7817, widened BRO-7874).
 *
 * A short announcement (closing date, opening date, cancellation, a star returning, a closing-night
 * bow) at a review outlet is not a review. ingest-urls.js wrote them as review files because nothing
 * asked what the page was:
 *   - Front Row Center, "To Kill A Mockingbird Sets Closing and Opening Dates" (its body ends
 *     "Read opening night reviews here.", so the BRO-7817 "never says review" test let it through);
 *   - Theater Pizzazz "Assassins Cancels Remaining Performances Due to COVID" (no text at all),
 *     "Patti LuPone Back in Company" and "Ain't Too Proud Bows to Closing Nite Audience" (slugs
 *     no slug rule could know; the body is plainly a notice).
 *
 * A page is refused when it is SHORT, has no review signal, and EITHER its url slug is
 * announcement-shaped and its body carries one announcement phrase, OR its body carries two or more
 * distinct announcement phrases. A page with no
 * extracted text is refused only on a cancellation / closing-night slug. A long page, a review-shaped slug, a star
 * rating, or the word "review" in the body's own prose (not a link to other reviews, not inside a
 * url) always passes, so a paywall teaser of a real review (WSJ, Broadway News) is never refused.
 */

const MONTH = '(?:january|february|march|april|may|june|july|august|september|october|november|december)';
const NEWS_SLUG = new RegExp([
  '(?:^|-)(?:',
  'sets?-(?:closing|opening)(?:-|$)',
  '|closing-(?:date|dates)(?:-|$)',
  `|closing-${MONTH}-\\d`,
  '|set-to-(?:open|close)$',
  '|celebrates?-\\d+(?:th|st|nd|rd)?-(?:years?|anniversary)',
  '|announces?-(?:cast|casting|extension|closing|opening|run|dates)',
  '|extends?-(?:run|its-run|through)',
  '|tickets?-(?:now-)?on-sale',
  '|cast-announced|casting-announced',
  // BRO-7874: cancellations and closing-night bows.
  '|cancel(?:s|ed|led|ling)?-(?:(?:all|its|the)-)?(?:remaining-)?performances?(?:-|$)',
  '|bows?-to-(?:a-)?closing',
  '|closing-(?:nite|night)-(?:audience|bow|performance)',
  '|plays?-(?:its-)?final-performance',
  ')',
].join(''), 'i');

// BRO-7874 review: with NO extracted text only a cancellation / closing-night slug is proof enough.
// Review outlets also title real reviews "...-tickets-on-sale-...", "...-celebrates-30th-anniversary-..."
// (Theatre Reviews Limited, Splash Magazines), and a failed extraction must not drop those.
const STRONG_NEWS_SLUG = /(?:^|-)(?:cancel(?:s|ed|led|ling)?-(?:(?:all|its|the)-)?(?:remaining-)?performances?(?:-|$)|bows?-to-(?:a-)?closing|closing-(?:nite|night)-(?:audience|bow|performance)|plays?-(?:its-)?final-performance)/i;

// Phrases that belong to an announcement, not a critique. Each is one signal; two distinct ones are
// needed when the slug says nothing. A review rarely carries even one of them.
const NEWS_BODY = [
  ['final-performance', /\bplay(?:s|ed)?\s+its\s+final\s+(?:\w+\s+){0,2}performance\b/i],
  ['performance-count', /\bplayed\s+[\d,]+\s+(?:\w+\s+){0,2}performances\b/i],
  ['will-close-reopen', /\bwill\s+(?:close|reopen|re-open|transfer)\b/i],
  ['cancelled', /\b(?:cancel(?:s|ed|led)|postpone[sd])\s+(?:(?:its|the|all)\s+)?(?:remaining\s+)?(?:\w+\s+)?performances?\b/i],
  ['recouped', /\brecoup(?:s|ed)\b/i],
  ['officially-opened', /\bofficially\s+opened\b/i],
  ['returned-after', /\breturn(?:s|ed)\s+to\b[^.]{0,80}\bafter\s+(?:a\s+)?(?:brief\s+|short\s+)?(?:absence|hiatus|leave|illness|recover)/i],
  ['covid-absence', /\b(?:recover(?:s|ed|ing)?\s+from\s+covid|tested\s+positive|due\s+to\s+covid)/i],
  ['curtain-call-speech', /\bcurtain\s+call\s+(?:speech(?:es)?|video)\b|\bat\s+the\s+stage\s+door\b/i],
  ['tickets-on-sale', /\btickets?\s+(?:are\s+)?(?:now\s+)?on\s+sale\b/i],
  ['extended', /\bextend(?:s|ed)?\s+(?:its\s+)?(?:run|engagement)\b|\b(?:run|engagement)\s+(?:has\s+been\s+)?extended\b/i],
  ['anniversary', /\bcelebrat(?:es|ed|ing)\s+(?:its\s+)?\d+(?:th|st|nd|rd)?\s+(?:years?|anniversary)\b/i],
  ['casting', /\b(?:join(?:s|ed)\s+the\s+cast|casting\s+(?:has\s+been\s+|was\s+)?announced)\b/i],
];

const WEAK_SIGNALS = new Set(['will-close-reopen', 'recouped', 'officially-opened', 'extended', 'anniversary', 'casting', 'tickets-on-sale']);
const MAX_NEWS_CHARS = 3000;
const REVIEW_WORD = /\breview(?:s|ed|er|ing)?\b/i;
const STAR_RATING = /(\d(?:\.\d)?\s*(?:out of|\/)\s*5(?:\s*stars?)?)|★{1,5}|\brating:\s*[A-F][+-]?\b/i;

function slugOf(url) {
  try { return new URL(url).pathname.replace(/\/+$/, '').split('/').slice(-1)[0] || ''; } catch { return String(url || ''); }
}

/** The body's own prose: urls and "read the reviews here" links to OTHER reviews removed. */
function proseOf(body) {
  return body
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\b(?:read|see|check\s+out)\s+(?:the\s+|all\s+)?(?:\w+\s+){0,3}reviews?\b(?:\s+(?:here|below))?/gi, ' ');
}

function newsSignals(body) {
  return NEWS_BODY.filter(([, re]) => re.test(body)).map(([name]) => name);
}

/**
 * @param {{url: string, text: string|null|undefined}} p
 * @returns {{news: boolean, reason?: string, signals?: string[]}}
 */
function classifyNewsPost({ url, text }) {
  const body = typeof text === 'string' ? text : '';
  const slug = slugOf(url);
  if (/review/i.test(slug)) return { news: false };
  const slugNews = NEWS_SLUG.test(slug);
  if (!body.trim()) {
    return STRONG_NEWS_SLUG.test(slug) ? { news: true, reason: 'cancellation / closing-night url slug and no article text' } : { news: false };
  }
  if (body.length > MAX_NEWS_CHARS) return { news: false };
  if (STAR_RATING.test(body)) return { news: false };
  if (REVIEW_WORD.test(proseOf(body))) return { news: false };
  const signals = newsSignals(body);
  // An announcement slug still needs one announcement phrase in the body: Theatre Reviews Limited
  // titles real reviews "...-tickets-on-sale-through-sunday-may-29-2016" (The Woodsman, scored 91).
  if (slugNews && signals.length >= 1) {
    return { news: true, signals, reason: `announcement-shaped url slug and a ${body.length}-char body with no "review"` };
  }
  // Ordinary review prose says "officially opened" or "will transfer", so weak phrases alone need three.
  const strongCount = signals.filter((n) => !WEAK_SIGNALS.has(n)).length;
  if ((strongCount >= 1 && signals.length >= 2) || signals.length >= 3) {
    return { news: true, signals, reason: `a ${body.length}-char body with announcement phrases (${signals.join(', ')}) and no "review"` };
  }
  return { news: false };
}

module.exports = { classifyNewsPost, NEWS_SLUG, STRONG_NEWS_SLUG, NEWS_BODY, MAX_NEWS_CHARS };
