'use strict';
/**
 * BRO-7291 class 4 (title typos copied from listings): a city-hub show staged as "Hangman" whose reviews all say
 * "Hangmen". Listings sites mistype titles and the staging step copied them verbatim. Cross-check our title
 * against the production's own review texts and the titles we already know (shows.json): when a known title one
 * or two letters away is what the reviews print, ours is the typo. Pure; no I/O.
 */

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

const mentions = (text, title) => {
  const words = norm(title).split(' ').filter(Boolean);
  if (!words.length) return 0;
  const re = new RegExp(`(?:^|[^a-z0-9])${words.join('[^a-z0-9]+')}(?![a-z0-9])`, 'g');
  return (norm(text).match(re) || []).length;
};

/**
 * @param {{ title: string }} show
 * @param {string[]} texts         the production's own (non-excluded) review texts
 * @param {string[]} knownTitles   titles of other shows (shows.json); the correct spelling must be one of them
 * @returns {{ title: string, ours: number, theirs: number, texts: number } | null}
 */
function titleSpellingFinding(show, texts, knownTitles) {
  const ours = norm(show && show.title);
  if (ours.length < 4 || !texts || !texts.length) return null;
  const cands = [...new Set((knownTitles || []).filter(Boolean))].filter((t) => {
    const n = norm(t);
    if (!n || n === ours || n[0] !== ours[0]) return false;
    const d = editDistance(n, ours);
    return d >= 1 && d <= (ours.length >= 8 ? 2 : 1);
  });
  let best = null;
  for (const t of cands) {
    let theirs = 0; let oursN = 0; let inTexts = 0;
    for (const x of texts) { const m = mentions(x, t); theirs += m; if (m) inTexts++; oursN += mentions(x, show.title); }
    // the reviews print the other spelling, in most texts, far more than ours (ours can be a plain word: "hangman")
    if (inTexts * 2 >= texts.length && inTexts >= Math.min(2, texts.length) && theirs >= 3 && theirs > 2 * oursN) {
      if (!best || theirs > best.theirs) best = { title: t, ours: oursN, theirs, texts: inTexts };
    }
  }
  return best;
}

module.exports = { titleSpellingFinding, editDistance };
