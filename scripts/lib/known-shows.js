/**
 * Known Broadway shows database for revival detection
 *
 * This helps auto-detect revivals when shows are discovered.
 * If a new show matches a title here, it's likely a revival.
 */

// Classic Broadway musicals - any production of these is likely a revival
const CLASSIC_MUSICALS = [
  'Chicago',
  'Cabaret',
  'Ragtime',
  'Gypsy',
  'Company',
  'Sweeney Todd',
  'Into the Woods',
  'Sunday in the Park with George',
  'Merrily We Roll Along',
  'Follies',
  'A Chorus Line',
  'The Music Man',
  'The King and I',
  'South Pacific',
  'The Sound of Music',
  'My Fair Lady',
  'Hello, Dolly!',
  'Fiddler on the Roof',
  'Annie',
  'Guys and Dolls',
  'Oklahoma!',
  'Carousel',
  'West Side Story',
  'The Phantom of the Opera',
  'Les Misérables',
  'Miss Saigon',
  'Rent',
  'Hair',
  'Evita',
  'Jesus Christ Superstar',
  'Joseph and the Amazing Technicolor Dreamcoat',
  'Cats',
  'Grease',
  'Chess',
  'Anything Goes',
  '42nd Street',
  'On the Town',
  'Pal Joey',
  'Kiss Me, Kate',
  'Show Boat',
  'Porgy and Bess',
  'Funny Girl',
  'Sweet Charity',
  'Pippin',
  'A Little Night Music',
  'Follies',
  'Pacific Overtures',
  'Chicago',
  'They\'re Playing Our Song',
  'Damn Yankees',
  'Once Upon a Mattress',
  'Little Shop of Horrors',
  'She Loves Me',
  'How to Succeed in Business Without Really Trying',
  'Bye Bye Birdie',
  'The Pajama Game',
  'Wonderful Town',
  'Call Me Madam',
  'Mame',
  'La Cage aux Folles',
  'A Funny Thing Happened on the Way to the Forum',
  'The Producers',
  'Spring Awakening',
  'Hairspray',
  'Avenue Q',
  'Kinky Boots',
  'The Color Purple',
  'Waitress',
  'Dear Evan Hansen',
  'Come From Away',
  'Mamma Mia!',
  'Jersey Boys',
  'Billy Elliot',
  'In the Heights',
  'Next to Normal',
  'Dogfight',
  'Parade',
  'Caroline, or Change',
];

// Classic Broadway plays
const CLASSIC_PLAYS = [
  'Death of a Salesman',
  'A Streetcar Named Desire',
  'The Glass Menagerie',
  'Who\'s Afraid of Virginia Woolf?',
  'Long Day\'s Journey Into Night',
  'The Iceman Cometh',
  'A Raisin in the Sun',
  'Cat on a Hot Tin Roof',
  'The Crucible',
  'Inherit the Wind',
  'Twelve Angry Men',
  'The Importance of Being Earnest',
  'Waiting for Godot',
  'Rosencrantz and Guildenstern Are Dead',
  'The Odd Couple',
  'Brighton Beach Memoirs',
  'Biloxi Blues',
  'Lost in Yonkers',
  'Angels in America',
  'Fences',
  'The Piano Lesson',
  'Ma Rainey\'s Black Bottom',
  'Joe Turner\'s Come and Gone',
  'Seven Guitars',
  'King Hedley II',
  'Radio Golf',
  'Gem of the Ocean',
  'A Doll\'s House',
  'Hedda Gabler',
  'The Master Builder',
  'An Enemy of the People',
  'The Seagull',
  'Three Sisters',
  'Uncle Vanya',
  'The Cherry Orchard',
  'Betrayal',
  'The Real Thing',
  'Arcadia',
  'The Coast of Utopia',
  'Rock \'n\' Roll',
  'Leopoldstadt',
];

/**
 * Check if a show title matches a known Broadway classic
 * Returns { isKnown: boolean, type: 'musical'|'play'|null }
 */
function checkKnownShow(title) {
  const normalizedTitle = title
    .toLowerCase()
    .replace(/[!?'":\-–—,\.]/g, '')
    .replace(/\s+at\s+the\s+.+$/i, '') // Remove "at the Kit Kat Club" style venue suffixes
    .trim();

  // Check musicals
  for (const classic of CLASSIC_MUSICALS) {
    const classicNormalized = classic
      .toLowerCase()
      .replace(/[!?'":\-–—,\.]/g, '')
      .trim();

    if (normalizedTitle === classicNormalized ||
        normalizedTitle.startsWith(classicNormalized + ' ') ||
        normalizedTitle.endsWith(' ' + classicNormalized)) {
      return { isKnown: true, type: 'musical' };
    }
  }

  // Check plays
  for (const classic of CLASSIC_PLAYS) {
    const classicNormalized = classic
      .toLowerCase()
      .replace(/[!?'":\-–—,\.]/g, '')
      .trim();

    if (normalizedTitle === classicNormalized ||
        normalizedTitle.startsWith(classicNormalized + ' ') ||
        normalizedTitle.endsWith(' ' + classicNormalized)) {
      return { isKnown: true, type: 'play' };
    }
  }

  return { isKnown: false, type: null };
}

/**
 * Detect if title suggests it's a play (vs musical)
 * Based on common patterns
 */
function detectPlayFromTitle(title) {
  const lowerTitle = title.toLowerCase();

  // Strong play indicators
  const playIndicators = [
    /\bplay\b/,
    /^the\s+\w+\s+play$/,
  ];

  for (const pattern of playIndicators) {
    if (pattern.test(lowerTitle)) {
      return true;
    }
  }

  return false;
}

module.exports = {
  checkKnownShow,
  detectPlayFromTitle,
  CLASSIC_MUSICALS,
  CLASSIC_PLAYS,
};
