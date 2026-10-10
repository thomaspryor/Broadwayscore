'use strict';
/**
 * Does a show title name itself a musical? Shared by discover-new-shows.js
 * (new-show type detection) and promote-owe-venue-candidates.js (BRO-4398
 * follow-up, 2026-10-01).
 *
 * The old discovery rule only matched a separator before the suffix
 * ("Dog Man - The Musical", "Show: A New Musical"), so six catalog rows were
 * typed play: "Death Note The Musical", "Trainspotting the musical",
 * "GOD IS A WOMAN THE MUSICAL", "Copperfield! The New Musical",
 * "Shamilton! The Improvised Hip-Hop Musical", "We've Been Here Before: A One
 * Woman Musical". The signal is "musical" as a noun: ending the title, or
 * mid-title before punctuation or a billing word ("Singfeld! A Musical About
 * Nothing", "Friends The Musical Parody"); never as an adjective ("The
 * Musical Comedy Murders of 1940", "Murder at the Musical Society").
 */
function titleSaysMusical(title) {
  const t = String(title || '').trim();
  if (!/(?<![-\w])musical\b/i.test(t)) return false;
  // The original discovery rule, kept whole: "Dog Man - The Musical Live",
  // "Hadestown: A Musical Experience".
  if (/[-–—:]\s*the\s+musical\b|:\s*a\s+(new\s+)?musical\b/i.test(t)) return true;
  // Ends in "musical" / "musical comedy": "Death Note The Musical",
  // "Musical Hell: A New Musical", "Monsters A Killer New Musical Comedy".
  if (/\bmusical(?:\s+comedy)?\W*$/i.test(t)) return true;
  // "Musical" opening the title is an adjective ("The Musical Comedy Murders
  // of 1940", "Musical Chairs").
  if (/^(?:the\s+)?musical\s+\S/i.test(t)) return false;
  // Mid-title, only the noun: "musical" followed by punctuation or by a word
  // that continues a show's own billing ("Friends The Musical Parody",
  // "Singfeld! A Musical About Nothing", "Midnight - A New Original Musical
  // by Todrick Hall", "... The Musical in Concert", "A Musical
  // Celebration"). Not "Musical Society", "Musical Interludes", "Musical
  // Theatre".
  return /\bmusical(?:\s*[:\-–—(,!]|\s+(?:parody|about|by|in|for|from|starring|celebration|revue|journey|adventure|fable|comedy)\b)/i.test(t);
}

/**
 * Show type for an automatically promoted row: the venue's own genre label
 * first (Spektrix "Musicals", "Musical - star casting"), then the title; the
 * default is 'play'. A label that names no type (Drama, Theatre, Children's
 * Show) falls back to the title. "Non-musical" / "non musical" labels do not
 * count. Opera labels are not mapped: arts centres use them for cinema
 * screenings too, and discovery files staged opera as 'special'.
 */
function showTypeFor(title, listingGenre) {
  const g = String(listingGenre || '').replace(/\bnon[\s-]*musicals?\b/gi, '');
  if (/(?<![-\w])musicals?\b/i.test(g)) return 'musical';
  return titleSaysMusical(title) ? 'musical' : 'play';
}

/**
 * Same, but null when nothing says what the show is (no genre label, no
 * "musical" in the title): for builders that leave an unknown type empty
 * rather than guess 'play'.
 */
function knownShowType(title, listingGenre) {
  const g = String(listingGenre || '').replace(/\bnon[\s-]*musicals?\b/gi, '');
  if (/(?<![-\w])musicals?\b/i.test(g) || titleSaysMusical(title)) return 'musical';
  // Only a label that names a play counts as one. "Opera", "Dance",
  // "Comedy", "Children's Show" leave the type unknown, also when a generic
  // "Theatre" category sits beside them ("Dance; Theatre").
  if (/\b(?:opera|dance|ballet|comedy|stand.?up|cabaret|music|concert|circus|magic|children|family|cinema|film|talk)\b/i.test(g)) return null;
  // A bare "Theatre" category is not one: venues tag musicals with it too.
  if (/\b(?:plays?|drama|new writing|revival)\b/i.test(g)) return 'play';
  return null;
}

module.exports = { titleSaysMusical, showTypeFor, knownShowType };
