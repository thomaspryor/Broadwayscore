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
 * Woman Musical". A title ENDING in "musical" (or "musical comedy") is the
 * signal anywhere in the title ("Singfeld! A Musical About Nothing",
 * "Friends The Musical Parody"), except as an opening adjective ("The Musical
 * Comedy Murders of 1940" is a play).
 */
function titleSaysMusical(title) {
  const t = String(title || '').trim();
  if (!/(?<![-\w])musical\b/i.test(t)) return false;
  // "Musical" opening the title is an adjective on the next word ("The
  // Musical Comedy Murders of 1940", "Musical Chairs"), unless it is the
  // whole title.
  if (/^(?:the\s+)?musical\s+\S/i.test(t)) return false;
  return true;
}

/**
 * Show type for an automatically promoted row: the venue's own genre label
 * first (Spektrix "Musicals" / "Musical - star casting" / "Opera"), then the
 * title. A label that names no type (Drama, Theatre, Children's Show) falls
 * back to the title; the default is 'play'.
 */
function showTypeFor(title, listingGenre) {
  const g = String(listingGenre || '');
  // "Non-musical drama" must not count: no hyphen or letter right before.
  if (/(?<![-\w])musicals?\b/i.test(g)) return 'musical';
  if (/\boperas?\b/i.test(g)) return 'opera';
  return titleSaysMusical(title) ? 'musical' : 'play';
}

module.exports = { titleSaysMusical, showTypeFor };
