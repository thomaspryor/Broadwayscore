'use strict';
/** Significant title tokens (moved from audit-show-review-gap.js, BRO-6804, so lib code can share it). */
function titleTokens(title) {
  // Significant tokens (3+ chars, not stopwords) from the show title.
  // Used to filter aggregator-article links to URLs actually about THIS show
  // (vs sidebar/related-article links).
  const STOPWORDS = new Set([
    'the','and','for','off','broadway','musical','play','theater','theatre',
    'review','reviews','what','are','is','of','to','in','on','at','a','an',
    'with','by','from','presents','starring','new','york','nyc','show',
  ]);
  // Fold diacritics BEFORE stripping non-alphanumerics. Without the NFD
  // decomposition the `[^a-z0-9 ]` strip turns each accented letter into a
  // SPACE, shredding one word into fragments that can never match an ASCII URL
  // slug: "Les Misérables" became ["les","mis","rables"] instead of
  // ["les","miserables"]. Because urlMatchesShow requires n-1 of n tokens, the
  // two phantom fragments made every real review URL for that show unmatchable
  // — the census reported "0 gaps" for Les Misérables: The Arena Concert
  // Spectacular on 2026-07-30 while amNewYork and New York Theatre Guide were
  // both live and missing. 28 corpus shows are affected; the worst are operas
  // where the fragment count collapses to 1-2 tokens and the `tokens.length<=2`
  // branch then demands a 100% match: "La Bohème" → ["boh"], "Jenůfa" → ["jen"].
  // Same fold as title-normalization.js:29 / show-matching.js:1078.
  const words = (title || '').toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const significant = words.filter(t => t.length >= 3 && !STOPWORDS.has(t));
  if (significant.length) return significant;
  // BRO-6629: a title made only of short or stopword tokens ("44", "Oz",
  // "The Play") used to yield [], and urlMatchesShow accepts EVERY link on an
  // empty token set, so a BWW/Playbill roundup sidebar for another show (the
  // Merrily URLs on "44") was booked as a missing review. Fall back to the
  // numeric / 2-char words, then to every word, so a token set exists.
  const short = words.filter(t => /^\d+$/.test(t) || (t.length >= 2 && !STOPWORDS.has(t)));
  return short.length ? short : words;
}

module.exports = { titleTokens };
