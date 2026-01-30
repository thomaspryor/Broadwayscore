#!/usr/bin/env node
/**
 * Add historical shows from 2023-2024 Broadway season
 * These are closed shows that need to be added to our database
 */

const fs = require('fs');
const path = require('path');

const { checkForDuplicate } = require('./lib/deduplication');

const showsPath = path.join(__dirname, '../data/shows.json');
const data = JSON.parse(fs.readFileSync(showsPath, 'utf8'));

// New shows to add from 2023-2024 season
const newShows = [
  // NEW MUSICALS
  {
    id: "days-of-wine-and-roses-2024",
    title: "Days of Wine and Roses",
    slug: "days-of-wine-and-roses",
    venue: "Studio 54",
    openingDate: "2024-01-28",
    closingDate: "2024-03-31",
    status: "closed",
    type: "musical",
    runtime: "2h 15m",
    intermissions: 1,
    synopsis: "A new musical adaptation of the classic 1962 film about two people who fall in love and descend into alcoholism together. With music by Adam Guettel and book by Craig Lucas.",
    tags: ["musical", "drama", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Kelli O'Hara", role: "Kirsten Arnesen" },
      { name: "Brian d'Arcy James", role: "Joe Clay" }
    ],
    creativeTeam: [
      { name: "Adam Guettel", role: "Music & Lyrics" },
      { name: "Craig Lucas", role: "Book" },
      { name: "Michael Greif", role: "Director" }
    ]
  },
  {
    id: "harmony-2023",
    title: "Harmony",
    slug: "harmony",
    venue: "Ethel Barrymore Theatre",
    openingDate: "2023-11-13",
    closingDate: "2024-02-04",
    status: "closed",
    type: "musical",
    runtime: "2h 30m",
    intermissions: 1,
    synopsis: "The story of the Comedian Harmonists, a singing group in 1920s and 30s Germany who became international stars before being silenced by the Nazi regime.",
    tags: ["musical", "drama", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Sierra Boggess", role: "Mary" },
      { name: "Chip Zien", role: "Rabbi" }
    ],
    creativeTeam: [
      { name: "Barry Manilow", role: "Music" },
      { name: "Bruce Sussman", role: "Lyrics & Book" },
      { name: "Warren Carlyle", role: "Director & Choreographer" }
    ]
  },
  {
    id: "here-lies-love-2023",
    title: "Here Lies Love",
    slug: "here-lies-love",
    venue: "Broadway Theatre",
    openingDate: "2023-07-20",
    closingDate: "2023-11-26",
    status: "closed",
    type: "musical",
    runtime: "1h 45m",
    intermissions: 0,
    synopsis: "An immersive dance-floor musical experience about the rise and fall of Imelda Marcos, First Lady of the Philippines. Features music by David Byrne and Fatboy Slim.",
    tags: ["musical", "immersive", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Arielle Jacobs", role: "Imelda Marcos" },
      { name: "Jose Llana", role: "Ferdinand Marcos" }
    ],
    creativeTeam: [
      { name: "David Byrne", role: "Music & Lyrics" },
      { name: "Fatboy Slim", role: "Music" },
      { name: "Alex Timbers", role: "Director" }
    ]
  },
  {
    id: "how-to-dance-in-ohio-2023",
    title: "How to Dance in Ohio",
    slug: "how-to-dance-in-ohio",
    venue: "Belasco Theatre",
    openingDate: "2023-12-10",
    closingDate: "2024-02-11",
    status: "closed",
    type: "musical",
    runtime: "2h 20m",
    intermissions: 1,
    synopsis: "Based on the documentary, this groundbreaking musical follows seven autistic young adults preparing for their first spring formal dance. Historic for featuring autistic actors in all seven lead roles.",
    tags: ["musical", "drama", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Amelia Fei", role: "Remy" },
      { name: "Desmond Luis Edwards", role: "Drew" }
    ],
    creativeTeam: [
      { name: "Jacob Yandura", role: "Music" },
      { name: "Rebekah Greer Melocik", role: "Lyrics" },
      { name: "Sammi Cannold", role: "Director" }
    ]
  },
  {
    id: "illinoise-2024",
    title: "Illinoise",
    slug: "illinoise",
    venue: "St. James Theatre",
    openingDate: "2024-04-24",
    closingDate: "2024-08-10",
    status: "closed",
    type: "musical",
    runtime: "1h 30m",
    intermissions: 0,
    synopsis: "A dance musical set to Sufjan Stevens' iconic album 'Illinois', telling stories of love, loss, and hope through breathtaking choreography.",
    tags: ["musical", "dance", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Ricky Ubeda", role: "Henry" }
    ],
    creativeTeam: [
      { name: "Sufjan Stevens", role: "Music & Lyrics" },
      { name: "Justin Peck", role: "Director & Choreographer" },
      { name: "Jackie Sibblies Drury", role: "Book" }
    ]
  },
  {
    id: "lempicka-2024",
    title: "Lempicka",
    slug: "lempicka",
    venue: "Longacre Theatre",
    openingDate: "2024-04-14",
    closingDate: "2024-05-19",
    status: "closed",
    type: "musical",
    runtime: "2h 30m",
    intermissions: 1,
    synopsis: "The story of bold Art Deco painter Tamara de Lempicka, exploring her artistic ambition, passionate love affairs, and escape from war-torn Europe.",
    tags: ["musical", "biography", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Eden Espinosa", role: "Tamara de Lempicka" },
      { name: "Amber Iman", role: "Rafaela" }
    ],
    creativeTeam: [
      { name: "Matt Gould", role: "Music" },
      { name: "Carson Kreitzer", role: "Book & Lyrics" },
      { name: "Rachel Chavkin", role: "Director" }
    ]
  },
  {
    id: "once-upon-a-one-more-time-2023",
    title: "Once Upon a One More Time",
    slug: "once-upon-a-one-more-time",
    venue: "Marquis Theatre",
    openingDate: "2023-06-22",
    closingDate: "2023-09-03",
    status: "closed",
    type: "musical",
    runtime: "2h",
    intermissions: 1,
    synopsis: "A jukebox musical featuring the songs of Britney Spears, where fairy tale princesses discover feminism and rewrite their own stories.",
    tags: ["musical", "jukebox", "comedy", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Briga Heelan", role: "Cinderella" }
    ],
    creativeTeam: [
      { name: "Britney Spears", role: "Music & Lyrics (catalog)" },
      { name: "Jon Hartmere", role: "Book" },
      { name: "Keone & Mari Madrid", role: "Directors & Choreographers" }
    ]
  },
  {
    id: "heart-of-rock-and-roll-2024",
    title: "The Heart of Rock and Roll",
    slug: "heart-of-rock-and-roll",
    venue: "James Earl Jones Theatre",
    openingDate: "2024-04-22",
    closingDate: "2024-06-23",
    status: "closed",
    type: "musical",
    runtime: "2h 15m",
    intermissions: 1,
    synopsis: "A jukebox musical featuring the songs of Huey Lewis and the News, following Bobby who must choose between his rock star dreams and a stable job.",
    tags: ["musical", "jukebox", "comedy", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Corey Cott", role: "Bobby" },
      { name: "McKenzie Kurtz", role: "Cassandra" }
    ],
    creativeTeam: [
      { name: "Huey Lewis", role: "Music & Lyrics (catalog)" },
      { name: "Jonathan A. Abrams", role: "Book" },
      { name: "Gordon Greenberg", role: "Director" }
    ]
  },

  // MUSICAL REVIVALS
  {
    id: "gutenberg-2023",
    title: "Gutenberg! The Musical!",
    slug: "gutenberg",
    venue: "James Earl Jones Theatre",
    openingDate: "2023-10-12",
    closingDate: "2024-01-28",
    status: "closed",
    type: "revival",
    runtime: "1h 30m",
    intermissions: 0,
    synopsis: "A two-man comedy musical about aspiring playwrights who present their ridiculous musical about Johannes Gutenberg using hats to play all the characters.",
    tags: ["musical", "comedy", "revival", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Josh Gad", role: "Bud Davenport" },
      { name: "Andrew Rannells", role: "Doug Simon" }
    ],
    creativeTeam: [
      { name: "Scott Brown", role: "Music, Lyrics & Book" },
      { name: "Anthony King", role: "Music, Lyrics & Book" },
      { name: "Alex Timbers", role: "Director" }
    ]
  },
  {
    id: "merrily-we-roll-along-2023",
    title: "Merrily We Roll Along",
    slug: "merrily-we-roll-along",
    venue: "Hudson Theatre",
    openingDate: "2023-10-10",
    closingDate: "2024-07-07",
    status: "closed",
    type: "revival",
    runtime: "2h 30m",
    intermissions: 1,
    synopsis: "Sondheim's musical told in reverse, following three friends—a composer, a playwright, and a writer—from middle-age success back to their hopeful youth. Tony-winning 2023 revival.",
    tags: ["musical", "drama", "revival", "tony-winner", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Jonathan Groff", role: "Franklin Shepard" },
      { name: "Daniel Radcliffe", role: "Charley Kringas" },
      { name: "Lindsay Mendez", role: "Mary Flynn" }
    ],
    creativeTeam: [
      { name: "Stephen Sondheim", role: "Music & Lyrics" },
      { name: "George Furth", role: "Book" },
      { name: "Maria Friedman", role: "Director" }
    ]
  },
  {
    id: "spamalot-2023",
    title: "Spamalot",
    slug: "spamalot",
    venue: "St. James Theatre",
    openingDate: "2023-11-16",
    closingDate: "2024-04-07",
    status: "closed",
    type: "revival",
    runtime: "2h 15m",
    intermissions: 1,
    synopsis: "The Tony Award-winning musical comedy lovingly ripped off from Monty Python and the Holy Grail, following King Arthur and his knights on their quest for the Holy Grail.",
    tags: ["musical", "comedy", "revival", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "James Monroe Iglehart", role: "King Arthur" },
      { name: "Leslie Rodriguez Kritzer", role: "Lady of the Lake" }
    ],
    creativeTeam: [
      { name: "Eric Idle", role: "Book, Lyrics & Music" },
      { name: "John Du Prez", role: "Music" },
      { name: "Josh Rhodes", role: "Director & Choreographer" }
    ]
  },
  {
    id: "the-whos-tommy-2024",
    title: "The Who's Tommy",
    slug: "the-whos-tommy",
    venue: "Nederlander Theatre",
    openingDate: "2024-03-28",
    closingDate: "2024-07-21",
    status: "closed",
    type: "revival",
    runtime: "2h 15m",
    intermissions: 1,
    synopsis: "A deaf, dumb, and blind boy becomes a pinball champion in this rock opera. The acclaimed revival directed by Des McAnuff featuring The Who's iconic score.",
    tags: ["musical", "rock", "revival", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Ali Louis Bourzgui", role: "Tommy" },
      { name: "Adam Jacobs", role: "Captain Walker" }
    ],
    creativeTeam: [
      { name: "Pete Townshend", role: "Music & Lyrics" },
      { name: "Des McAnuff", role: "Director" }
    ]
  },
  {
    id: "the-wiz-2024",
    title: "The Wiz",
    slug: "the-wiz",
    venue: "Marquis Theatre",
    openingDate: "2024-04-17",
    closingDate: "2024-08-18",
    status: "closed",
    type: "revival",
    runtime: "2h 30m",
    intermissions: 1,
    synopsis: "The Tony-winning African American retelling of The Wizard of Oz with a soulful R&B score. Starring Wayne Brady and Deborah Cox.",
    tags: ["musical", "revival", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Wayne Brady", role: "The Wiz" },
      { name: "Deborah Cox", role: "Glinda" },
      { name: "Nichelle Lewis", role: "Dorothy" }
    ],
    creativeTeam: [
      { name: "Charlie Smalls", role: "Music & Lyrics" },
      { name: "William F. Brown", role: "Book" },
      { name: "Schele Williams", role: "Director" }
    ]
  },

  // NEW PLAYS
  {
    id: "grey-house-2023",
    title: "Grey House",
    slug: "grey-house",
    venue: "Lyceum Theatre",
    openingDate: "2023-05-30",
    closingDate: "2023-07-30",
    status: "closed",
    type: "play",
    runtime: "2h 10m",
    intermissions: 1,
    synopsis: "A horror play about a couple who crashes their car in the mountains and seeks shelter in a cabin, only to discover terrifying secrets within.",
    tags: ["play", "thriller", "horror", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Tatiana Maslany", role: "Min" },
      { name: "Paul Sparks", role: "Henry" }
    ],
    creativeTeam: [
      { name: "Levi Holloway", role: "Playwright" },
      { name: "Joe Mantello", role: "Director" }
    ]
  },
  {
    id: "i-need-that-2023",
    title: "I Need That",
    slug: "i-need-that",
    venue: "American Airlines Theatre",
    openingDate: "2023-11-02",
    closingDate: "2023-12-30",
    status: "closed",
    type: "play",
    runtime: "1h 45m",
    intermissions: 0,
    synopsis: "A darkly comic new play about a man buried alive in his stuff and the estranged family members trying to help him.",
    tags: ["play", "comedy", "drama", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Danny DeVito", role: "Foster" }
    ],
    creativeTeam: [
      { name: "Theresa Rebeck", role: "Playwright" },
      { name: "Moritz von Stuelpnagel", role: "Director" }
    ]
  },
  {
    id: "jajas-african-hair-braiding-2023",
    title: "Jaja's African Hair Braiding",
    slug: "jajas-african-hair-braiding",
    venue: "Samuel J. Friedman Theatre",
    openingDate: "2023-10-03",
    closingDate: "2023-11-19",
    status: "closed",
    type: "play",
    runtime: "1h 45m",
    intermissions: 0,
    synopsis: "A vibrant comedy set in a Harlem hair braiding salon on the hottest day of summer, where the lives of West African immigrant women intertwine.",
    tags: ["play", "comedy", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Somi Kakoma", role: "Jaja" }
    ],
    creativeTeam: [
      { name: "Jocelyn Bioh", role: "Playwright" },
      { name: "Whitney White", role: "Director" }
    ]
  },
  {
    id: "just-for-us-2023",
    title: "Just for Us",
    slug: "just-for-us",
    venue: "Hudson Theatre",
    openingDate: "2023-06-26",
    closingDate: "2023-08-19",
    status: "closed",
    type: "play",
    runtime: "1h 30m",
    intermissions: 0,
    synopsis: "Alex Edelman's solo show about accidentally attending a secret gathering of white supremacists, blending comedy with sharp social commentary.",
    tags: ["play", "comedy", "solo-show", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Alex Edelman", role: "Himself" }
    ],
    creativeTeam: [
      { name: "Alex Edelman", role: "Playwright" },
      { name: "Adam Brace", role: "Co-Writer" },
      { name: "Moritz von Stuelpnagel", role: "Director" }
    ]
  },
  {
    id: "mary-jane-2024",
    title: "Mary Jane",
    slug: "mary-jane",
    venue: "Samuel J. Friedman Theatre",
    openingDate: "2024-04-23",
    closingDate: "2024-06-30",
    status: "closed",
    type: "play",
    runtime: "1h 40m",
    intermissions: 0,
    synopsis: "A profound drama about a single mother caring for her medically fragile son, finding community among the nurses, therapists, and caregivers who help her.",
    tags: ["play", "drama", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Rachel McAdams", role: "Mary Jane" }
    ],
    creativeTeam: [
      { name: "Amy Herzog", role: "Playwright" },
      { name: "Anne Kauffman", role: "Director" }
    ]
  },
  {
    id: "mother-play-2024",
    title: "Mother Play",
    slug: "mother-play",
    venue: "Helen Hayes Theatre",
    openingDate: "2024-04-25",
    closingDate: "2024-06-16",
    status: "closed",
    type: "play",
    runtime: "2h 10m",
    intermissions: 1,
    synopsis: "Paula Vogel's autobiographical memory play exploring her complicated relationship with her mother through decades of family history.",
    tags: ["play", "drama", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Jessica Lange", role: "Phyllis" },
      { name: "Jim Parsons", role: "Carl" },
      { name: "Celia Keenan-Bolger", role: "Martha" }
    ],
    creativeTeam: [
      { name: "Paula Vogel", role: "Playwright" },
      { name: "Tina Landau", role: "Director" }
    ]
  },
  {
    id: "patriots-2024",
    title: "Patriots",
    slug: "patriots",
    venue: "Ethel Barrymore Theatre",
    openingDate: "2024-04-22",
    closingDate: "2024-06-23",
    status: "closed",
    type: "play",
    runtime: "2h 45m",
    intermissions: 1,
    synopsis: "A political thriller about Boris Berezovsky's role in Vladimir Putin's rise to power, and the oligarch's subsequent fall from grace.",
    tags: ["play", "drama", "political", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Michael Stuhlbarg", role: "Boris Berezovsky" },
      { name: "Will Keen", role: "Vladimir Putin" }
    ],
    creativeTeam: [
      { name: "Peter Morgan", role: "Playwright" },
      { name: "Rupert Goold", role: "Director" }
    ]
  },
  {
    id: "prayer-for-the-french-republic-2024",
    title: "Prayer for the French Republic",
    slug: "prayer-for-the-french-republic",
    venue: "Samuel J. Friedman Theatre",
    openingDate: "2024-01-09",
    closingDate: "2024-03-03",
    status: "closed",
    type: "play",
    runtime: "3h",
    intermissions: 1,
    synopsis: "An epic family drama spanning generations, exploring the lives of a Jewish family in France grappling with rising antisemitism and questions of identity.",
    tags: ["play", "drama", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Betsy Aidem", role: "Marcelle" },
      { name: "Anthony Edwards", role: "Charles Benhamou" }
    ],
    creativeTeam: [
      { name: "Joshua Harmon", role: "Playwright" },
      { name: "David Cromer", role: "Director" }
    ]
  },
  {
    id: "the-cottage-2023",
    title: "The Cottage",
    slug: "the-cottage",
    venue: "Helen Hayes Theatre",
    openingDate: "2023-07-24",
    closingDate: "2023-10-29",
    status: "closed",
    type: "play",
    runtime: "1h 50m",
    intermissions: 0,
    synopsis: "A farce set in 1920s England where a wife's infidelity is discovered, leading to a cascade of comic revelations and twists.",
    tags: ["play", "comedy", "farce", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Laura Bell Bundy", role: "Sylvia" },
      { name: "Lilli Cooper", role: "Marjorie" },
      { name: "Alex Moffat", role: "Van" }
    ],
    creativeTeam: [
      { name: "Sandy Rustin", role: "Playwright" },
      { name: "Jason Alexander", role: "Director" }
    ]
  },
  {
    id: "the-shark-is-broken-2023",
    title: "The Shark Is Broken",
    slug: "the-shark-is-broken",
    venue: "John Golden Theatre",
    openingDate: "2023-08-10",
    closingDate: "2023-11-19",
    status: "closed",
    type: "play",
    runtime: "1h 40m",
    intermissions: 0,
    synopsis: "A behind-the-scenes comedy about the chaotic filming of Jaws, as three actors stuck on a boat deal with mechanical failures and clashing egos.",
    tags: ["play", "comedy", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Ian Shaw", role: "Robert Shaw" },
      { name: "Colin Donnell", role: "Roy Scheider" },
      { name: "Alex Brightman", role: "Richard Dreyfuss" }
    ],
    creativeTeam: [
      { name: "Ian Shaw", role: "Playwright" },
      { name: "Joseph Nixon", role: "Playwright" },
      { name: "Guy Masterson", role: "Director" }
    ]
  },

  // PLAY REVIVALS
  {
    id: "an-enemy-of-the-people-2024",
    title: "An Enemy of the People",
    slug: "an-enemy-of-the-people",
    venue: "Circle in the Square Theatre",
    openingDate: "2024-03-18",
    closingDate: "2024-06-23",
    status: "closed",
    type: "revival",
    runtime: "2h",
    intermissions: 1,
    synopsis: "Ibsen's classic play about a doctor who discovers the town's water supply is contaminated and faces fierce opposition when trying to expose the truth.",
    tags: ["play", "drama", "revival", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Jeremy Strong", role: "Dr. Thomas Stockmann" },
      { name: "Michael Imperioli", role: "Peter Stockmann" }
    ],
    creativeTeam: [
      { name: "Henrik Ibsen", role: "Playwright" },
      { name: "Amy Herzog", role: "Adaptation" },
      { name: "Sam Gold", role: "Director" }
    ]
  },
  {
    id: "appropriate-2023",
    title: "Appropriate",
    slug: "appropriate",
    venue: "Hayes Theater",
    openingDate: "2023-12-18",
    closingDate: "2024-06-30",
    status: "closed",
    type: "revival",
    runtime: "2h 25m",
    intermissions: 1,
    synopsis: "Three estranged siblings reunite to settle their late father's estate in Arkansas, where a disturbing discovery forces them to confront dark family secrets.",
    tags: ["play", "drama", "revival", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Sarah Paulson", role: "Toni" },
      { name: "Corey Stoll", role: "Franz" },
      { name: "Michael Esper", role: "Bo" }
    ],
    creativeTeam: [
      { name: "Branden Jacobs-Jenkins", role: "Playwright" },
      { name: "Lila Neugebauer", role: "Director" }
    ]
  },
  {
    id: "doubt-2024",
    title: "Doubt: A Parable",
    slug: "doubt",
    venue: "Todd Haimes Theatre",
    openingDate: "2024-03-07",
    closingDate: "2024-04-21",
    status: "closed",
    type: "revival",
    runtime: "1h 30m",
    intermissions: 0,
    synopsis: "A nun becomes suspicious of a priest's relationship with a young student at a Bronx Catholic school in this Pulitzer Prize-winning drama.",
    tags: ["play", "drama", "revival", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Amy Ryan", role: "Sister Aloysius" },
      { name: "Liev Schreiber", role: "Father Flynn" }
    ],
    creativeTeam: [
      { name: "John Patrick Shanley", role: "Playwright" },
      { name: "Scott Ellis", role: "Director" }
    ]
  },
  {
    id: "purlie-victorious-2023",
    title: "Purlie Victorious: A Non-Confederate Romp Through the Cotton Patch",
    slug: "purlie-victorious",
    venue: "Music Box Theatre",
    openingDate: "2023-09-27",
    closingDate: "2024-02-04",
    status: "closed",
    type: "revival",
    runtime: "2h 10m",
    intermissions: 1,
    synopsis: "A satirical comedy about a self-appointed preacher returning to the Georgia town of his youth to claim the inheritance of his aunt, integrating the church and reclaiming land.",
    tags: ["play", "comedy", "revival", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Leslie Odom Jr.", role: "Purlie Victorious Judson" },
      { name: "Kara Young", role: "Lutiebelle" },
      { name: "Billy Eugene Jones", role: "Gitlow" }
    ],
    creativeTeam: [
      { name: "Ossie Davis", role: "Playwright" },
      { name: "Kenny Leon", role: "Director" }
    ]
  },
  {
    id: "uncle-vanya-2024",
    title: "Uncle Vanya",
    slug: "uncle-vanya",
    venue: "Vivian Beaumont Theater",
    openingDate: "2024-04-24",
    closingDate: "2024-06-16",
    status: "closed",
    type: "revival",
    runtime: "2h 20m",
    intermissions: 1,
    synopsis: "Chekhov's masterpiece about a family gathering at a rural estate where simmering resentments and unrequited loves come to the surface.",
    tags: ["play", "drama", "revival", "historical", "2023-2024-season"],
    images: { poster: null, thumbnail: null, hero: null },
    ticketLinks: [],
    cast: [
      { name: "Steve Carell", role: "Vanya" },
      { name: "William Jackson Harper", role: "Astrov" },
      { name: "Anika Noni Rose", role: "Yelena" }
    ],
    creativeTeam: [
      { name: "Anton Chekhov", role: "Playwright" },
      { name: "Heidi Schreck", role: "Adaptation" },
      { name: "Lila Neugebauer", role: "Director" }
    ]
  }
];

// Add shows that don't already exist (using full dedup module)
let addedCount = 0;
newShows.forEach(show => {
  const check = checkForDuplicate(show, data.shows);
  if (check.isDuplicate) {
    console.log(`SKIP: ${show.title} (${show.id}) — ${check.reason}`);
  } else {
    data.shows.push(show);
    addedCount++;
    console.log(`ADDED: ${show.title} (${show.id})`);
  }
});

// Update metadata
data._meta.lastUpdated = new Date().toISOString().split('T')[0];

// Write back
fs.writeFileSync(showsPath, JSON.stringify(data, null, 2));
console.log(`\n✅ Added ${addedCount} historical shows from 2023-2024 season`);
console.log(`Total shows in database: ${data.shows.length}`);
