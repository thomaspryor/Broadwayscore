// BRO-7909: fuzzy cue timing for the unattended lane. Whisper spells outlet names by ear
// ("Theatrely" -> "Theaterly"), so an exact stem match missed and the whole video failed.
const stem = t => t.replace(/s$/, '');
// consonant skeleton: first letter + consonants with repeats collapsed ("theatrely" and "theaterly" both -> "thtrly")
const skeleton = t => t[0] + t.slice(1).replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1');
/** Index of the first token at/after `start` that sounds like `word`, or -1. tk = [{k, a}]. */
function fuzzyFind(tk, word, start) {
  const ok = t => stem(t.k) === stem(word) || (word.length >= 5 && t.k.length >= 5 && /^[a-z]+$/.test(word + t.k) && skeleton(t.k) === skeleton(word) && skeleton(word).length >= 4);
  return tk.findIndex(x => x.a >= start - 1e-6 && ok(x));
}
// Whisper can mishear a rare outlet name outright (CitiTour -> "Vulture"); unattended (VO_FUZZY_CUES=1), time the card from
// the spoken excerpt instead (the voice says "<outlet> said, <excerpt>", so the card lands about a second late at worst).
function quoteCue(V, q, outletCue) {
  try { return V.at(outletCue(q.say)); } catch (e) {
    if (process.env.VO_FUZZY_CUES !== '1') throw e;
    const prev = V.cur(), t = V.at(String(q.ex).split(/\s+/).slice(0, 3).join(' '));
    return Math.max(prev, t - 1);
  }
}
module.exports = { fuzzyFind, skeleton, quoteCue };
