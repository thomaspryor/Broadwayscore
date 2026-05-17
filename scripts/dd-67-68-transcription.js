#!/usr/bin/env node
/**
 * Hand-transcribed Drama Desk Awards 67th (2023 ceremony, 2022-23 season)
 * and 68th (2024 ceremony, 2023-24 season).
 *
 * Sources (verified 2026-05-16):
 *   67th: https://www.broadwayworld.com/article/SOME-LIKE-IT-HOT-PARADE-and-More-Take-Home-2023-Drama-Desk-Awards-Full-List-of-Winners-20230531
 *         cross-referenced with https://www.dramadesk.org/drama-desk-2023-winners/
 *   68th: https://www.broadwayworld.com/article/2024-Drama-Desk-Awards-Winners--Updating-Live-20240610
 *         cross-referenced with https://theaterlife.com/drama-desk-nominations-2023-2024/
 *
 * These two ceremonies have no Wikipedia per-ceremony pages, so they are
 * hand-transcribed from the official BroadwayWorld winner announcements.
 *
 * Convention:
 *   - For performance/direction/design categories the "winner" / "nominees"
 *     entries hold the SHOW name (not the person), matching the rest of
 *     drama-desk.json which is keyed by show for awards-scoring lookup.
 *   - 2023 (67th) and 2024 (68th) acting categories had TWO winners each
 *     (first gender-neutral year for DD); both are captured in the
 *     `winners` array. The legacy `winner` field gets the first.
 *
 * Usage:
 *   node scripts/dd-67-68-transcription.js           # dry-run, print diff
 *   node scripts/dd-67-68-transcription.js --write
 */

const fs = require('fs');
const path = require('path');
const { writePrecursorJson, PRECURSORS_DIR } = require('./lib/precursor-wikipedia');

const WRITE = process.argv.includes('--write');

// ----- DD 67th (2023 ceremony, 2022-23 season) -----
const DD_2023 = {
  'Outstanding Play': {
    winner: 'Leopoldstadt',
    nominees: [
      'A Case for the Existence of God',
      'Fat Ham',
      'Leopoldstadt',
      'Love',
      'Prima Facie',
      'Wish You Were Here',
    ],
  },
  'Outstanding Musical': {
    winner: 'Some Like It Hot',
    nominees: [
      '& Juliet',
      'Between the Lines',
      "F*ck7thGrade",
      'Shucked',
      'Some Like It Hot',
      'White Girl in Danger',
    ],
  },
  'Outstanding Revival of a Play': {
    winner: 'The Piano Lesson',
    nominees: [
      'A Raisin in the Sun',
      'Death of a Salesman',
      'Endgame',
      'Ohio State Murders',
      'The Piano Lesson',
      'Wedding Band',
    ],
  },
  'Outstanding Revival of a Musical': {
    winner: 'Parade',
    nominees: [
      'A Man of No Importance',
      'Into the Woods',
      'Merrily We Roll Along',
      'Parade',
      'Sweeney Todd',
    ],
  },
  'Outstanding Lead Performance in a Play': {
    // Two winners (gender-neutral first year): Jessica Chastain (A Doll's House) + Sean Hayes (Good Night, Oscar)
    winner: "A Doll's House",
    nominees: [
      "A Doll's House",       // Jessica Chastain (W)
      'Good Night, Oscar',    // Sean Hayes (W)
      'Life of Pi',           // Hiran Abeysekera
      'A Case for the Existence of God', // Kyle Beltran + Will Brill (2 entries)
      'Wedding Band',         // Brittany Bradford
      'Death of a Salesman',  // Sharon D. Clarke + Wendell Pierce
      'Amani',                // Denise Manning
      'Ohio State Murders',   // Audra McDonald
      'Endgame',              // John Douglas Thompson
      'Twelfth Night',        // Kara Young
    ],
  },
  'Outstanding Lead Performance in a Musical': {
    winner: 'Sweeney Todd',
    nominees: [
      'Sweeney Todd',         // Annaleigh Ashford (W)
      'Some Like It Hot',     // J. Harrison Ghee (W)
      'The Butcher Boy',      // Nicholas Barasch
      'Into the Woods',       // Sara Bareilles
      'Camelot',              // Andrew Burnap
      'Parade',               // Micaela Diamond
      'Shucked',              // Andrew Durand
      'Kinky Boots',          // Callum Francis
      'Merrily We Roll Along', // Jonathan Groff + Lindsay Mendez
      'Dreaming Zenzile',     // Somi Kakoma
      'New York, New York',   // Anna Uzele
    ],
  },
  'Outstanding Featured Performance in a Play': {
    winner: "The Sign in Sidney Brustein's Window",
    nominees: [
      "The Sign in Sidney Brustein's Window", // Miriam Silverman (W)
      'Leopoldstadt',         // Brandon Uranowitz (W)
      'Good Night, Oscar',    // Emily Bergl
      'The Piano Lesson',     // Danielle Brooks + Ray Fisher
      'Love',                 // Amelda Brown + Nick Holder
      'Downstate',            // K. Todd Freeman + Francis Guinan
      "A Doll's House",       // Arian Moayed
      'Wolf Play',            // Brian Quijada
      'Cost of Living',       // Kara Young
    ],
  },
  'Outstanding Featured Performance in a Musical': {
    winner: 'Some Like It Hot',
    nominees: [
      'Some Like It Hot',     // Kevin Del Aguila (W)
      'Shucked',              // Alex Newell (W), Kevin Cahoon
      'A Beautiful Noise',    // Robyn Hurder + Mark Jacoby
      'White Girl in Danger', // Tarra Conner Jones
      'Into the Woods',       // Julia Lester + Phillipa Soo
      'Merrily We Roll Along', // Daniel Radcliffe
      'A Man of No Importance', // Mare Winningham
    ],
  },
  'Outstanding Direction of a Play': {
    winner: 'Life of Pi',
    nominees: [
      'Life of Pi',           // Max Webster (W)
      'On That Day in Amsterdam', // Zi Alikhan
      'Public Obscenities',   // Shayok Misha Chowdhury
      'Death of a Salesman',  // Miranda Cromwell
      'Peter Pan Goes Wrong', // Adam Meggido
      'Love',                 // Alexander Zeldin
    ],
  },
  'Outstanding Direction of a Musical': {
    winner: 'Sweeney Todd',
    nominees: [
      'Sweeney Todd',         // Thomas Kail (W)
      'Between the Lines',    // Jeff Calhoun
      'A Man of No Importance', // John Doyle
      'Merrily We Roll Along', // Maria Friedman
      'Shucked',              // Jack O'Brien
    ],
  },
  'Outstanding Choreography': {
    winner: 'Some Like It Hot',
    nominees: [
      'Some Like It Hot',     // Casey Nicholaw (W)
      'Only Gold',            // Andy Blankenbuehler
      'the bandaged place',   // Tislarm Bouie
      'The Harder They Come', // Edgar Godineaux
      'New York, New York',   // Susan Stroman
      'KPOP',                 // Jennifer Weber
    ],
  },
  'Outstanding Music': {
    winner: 'Shucked',
    nominees: [
      'Shucked',              // Brandy Clark and Shane McAnally (W)
      'White Girl in Danger', // Michael R. Jackson
      'Almost Famous',        // Tom Kitt and AnnMarie Milazzo
      'Between the Lines',    // Elyssa Samsel and Kate Anderson
      'Weightless',           // The Kilbanes
    ],
  },
  'Outstanding Lyrics': {
    winner: 'Some Like It Hot',
    nominees: [
      'Some Like It Hot',     // Scott Wittman and Marc Shaiman (W)
      'Shucked',              // Brandy Clark and Shane McAnally
      'Stranger Sings!',      // Jonathan Hogue
      'White Girl in Danger', // Michael R. Jackson
      'The Bedwetter',        // Adam Schlesinger and Sarah Silverman
    ],
  },
  'Outstanding Book of a Musical': {
    winner: 'Some Like It Hot',
    nominees: [
      'Some Like It Hot',     // Matthew López and Amber Ruffin (W)
      'Stranger Sings!',      // Jonathan Hogue
      'Shucked',              // Robert Horn
      'Titanique',            // Marla Mindelle, Constantine Rousouli, and Tye Blue
      '& Juliet',             // David West Read
    ],
  },
  'Outstanding Orchestrations': {
    winner: 'Some Like It Hot',
    nominees: [
      'Some Like It Hot',     // Charlie Rosen and Bryan Carter (W)
      'A Man of No Importance', // Bruce Coughlin
      'Shucked',              // Jason Howland
      'The Harder They Come', // Kenny Seymour
      'New York, New York',   // Daryl Waters and Sam Davis
    ],
  },
  'Outstanding Music in a Play': {
    winner: 'Plays for the Plague Year',
    nominees: [
      'Plays for the Plague Year', // Suzan-Lori Parks (W)
      'Letters from Max',     // Ben Edelman, Zane Pais, and Sinan Refik Zafar
      'the bandaged place',   // Mauricio Escamilla
      'Wuthering Heights',    // Ian Ross
      'Montag',               // Daniel Schlosberg
    ],
  },
  'Outstanding Scenic Design of a Play': {
    winner: 'Life of Pi',
    nominees: [
      'Life of Pi',           // Tim Hatley (W)
      'Wedding Band',         // Jason Ardizzone-West
      'Ohio State Murders',   // Beowulf Boritt
      'Public Obscenities',   // dots
      'Love',                 // Natasha Jenkins
      'Chains',               // John McDermott
    ],
  },
  'Outstanding Scenic Design of a Musical': {
    winner: 'New York, New York',
    nominees: [
      'New York, New York',   // Beowulf Boritt (W)
      'Only Gold',            // David Korins
      'Shucked',              // Scott Pask
      'Stranger Sings!',      // Walt Spangler and Brendan McCann
      'Camelot',              // Michael Yeargan
    ],
  },
  'Outstanding Costume Design of a Play': {
    winner: "Ain't No Mo'",
    nominees: [
      "Ain't No Mo'",         // Emilio Sosa (W)
      'According to the Chorus', // Kara Branch
      'Public Obscenities',   // Enver Chakartash
      'Wedding Band',         // Qween Jean
      'Wish You Were Here',   // Sarah Laux
      'Peter Pan Goes Wrong', // Roberto Surace
    ],
  },
  'Outstanding Costume Design of a Musical': {
    winner: 'Some Like It Hot',
    nominees: [
      'Some Like It Hot',     // Gregg Barnes (W)
      'Shucked',              // Tilly Grimes
      'Camelot',              // Jennifer Moeller
      'KPOP',                 // Clint Ramos and Sophia Choi
      'Only Gold',            // Anita Yavich
      'New York, New York',   // Donna Zakowska
    ],
  },
  'Outstanding Lighting Design of a Play': {
    winner: 'Prima Facie',
    nominees: [
      'Prima Facie',          // Natasha Chivers and Willie Williams (W)
      'Epiphany',             // Isabella Byrd
      'The Far Country',      // Jiyoun Chang
      'Ohio State Murders',   // Allen Lee Hughes
      'On That Day in Amsterdam', // Cha See
      'The Piano Lesson',     // Japhy Weideman
    ],
  },
  'Outstanding Lighting Design of a Musical': {
    winner: 'Sweeney Todd',
    nominees: [
      'Sweeney Todd',         // Natasha Katz (W)
      'New York, New York',   // Ken Billington
      'Only Gold',            // Jeff Croiter
      'Parade',               // Heather Gilbert
      "Bob Fosse's Dancin'",  // David Grill
    ],
  },
  'Outstanding Sound Design of a Play': {
    winner: "A Doll's House",
    nominees: [
      "A Doll's House",       // Ben & Max Ringham (W)
      'Ohio State Murders',   // Justin Ellington
      'Hamlet',               // Tom Gibbons
      'Love',                 // Josh Anio Grigg
      'You Will Get Sick',    // Lee Kinney and Daniel Kluger
      'Fat Ham',              // Mikaal Sulaiman
    ],
  },
  'Outstanding Sound Design of a Musical': {
    winner: 'Into the Woods',
    nominees: [
      'Into the Woods',       // Scott Lehrer and Alex Neumann (W)
      'Almost Famous',        // Peter Hylenski
      'Shucked',              // John Shivers
      'Weightless',           // Joanna Lynne Staub
      'Parade',               // Jon Weston
    ],
  },
  'Outstanding Projection Design': {
    winner: 'Life of Pi',
    nominees: [
      'Life of Pi',           // Andrzej Goulding (W)
      'Wuthering Heights',    // Simon Baker
      'Between the Lines',    // Caite Hevner
      'White Girl in Danger', // Josh Higgason
      'On That Day in Amsterdam', // Nicholas Hussong
      'Public Obscenities',   // Johnny Moreno
    ],
  },
  'Outstanding Solo Performance': {
    winner: 'Prima Facie',
    nominees: [
      'Prima Facie',          // Jodie Comer (W)
      'Four Saints in Three Acts', // David Greenspan
      'Walking With Bubbles', // Jessica Hendy
      'Without You',          // Anthony Rapp
      'Jack Was Kind',        // Tracy Thorne
    ],
  },
};

// ----- DD 68th (2024 ceremony, 2023-24 season) -----
const DD_2024 = {
  'Outstanding Play': {
    winner: 'Stereophonic',
    nominees: [
      'Stereophonic',
      'Infinite Life',
      "Jaja's African Hair Braiding",
      'Mother Play',
      'Swing State',
      'The Ally',
    ],
  },
  'Outstanding Musical': {
    winner: 'Dead Outlaw',
    nominees: [
      'Dead Outlaw',
      'Illinoise',
      'Lizard Boy',
      'Teeth',
      'The Connector',
      'The Outsiders',
    ],
  },
  'Outstanding Revival of a Play': {
    winner: 'Appropriate',
    nominees: [
      'Appropriate',
      'Doubt: A Parable',
      'Philadelphia, Here I Come!',
      'Purlie Victorious',
      'Uncle Vanya',
    ],
  },
  'Outstanding Revival of a Musical': {
    winner: 'I Can Get It for You Wholesale',
    nominees: [
      'I Can Get It for You Wholesale',
      'Cabaret at the Kit Kat Club',
      'Gutenberg! The Musical!',
    ],
  },
  'Outstanding Lead Performance in a Play': {
    winner: 'Mother Play',
    nominees: [
      'Mother Play',          // Jessica Lange (W)
      'Appropriate',          // Sarah Paulson (W)
      'Macbeth (an undoing)', // Nicole Cooper
      'Primary Trust',        // William Jackson Harper
      'Mary Jane',            // Rachel McAdams
      'The Hunt',             // Tobias Menzies
      'Purlie Victorious',    // Leslie Odom Jr.
      'Philadelphia, Here I Come!', // A.J. Shively
      'The Doctor',           // Juliet Stevenson
      'Patriots',             // Michael Stuhlbarg
    ],
  },
  'Outstanding Lead Performance in a Musical': {
    winner: 'Days of Wine and Roses',
    nominees: [
      'Days of Wine and Roses', // Brian d'Arcy James (W) + Kelli O'Hara (W)
      "Hell's Kitchen",       // Maleah Joi Moon (W)
      'Dead Outlaw',          // Andrew Durand
      'I Can Get It for You Wholesale', // Santino Fontana
      'The Outsiders',        // Brody Grant
      'How to Dance in Ohio', // Liam Pearce
      'Cabaret at the Kit Kat Club', // Gayle Rankin
      'The Connector',        // Ben Levi Ross
      'Illinoise',            // Ricky Ubeda
    ],
  },
  'Outstanding Featured Performance in a Play': {
    winner: 'Mother Play',
    nominees: [
      'Mother Play',          // Celia Keenan-Bolger (W)
      'Purlie Victorious',    // Kara Young (W)
      "Jaja's African Hair Braiding", // Brittany Adebumola
      'Infinite Life',        // Marylouise Burke
      'Appropriate',          // Michael Esper
      'Uncle Vanya',          // Marin Ireland
      'Patriots',             // Will Keen
      'Oh, Mary!',            // Conrad Ricamora
      'Manahatta',            // Sheila Tousey
      'Swing State',          // Bubba Weiler
    ],
  },
  'Outstanding Featured Performance in a Musical': {
    winner: "Hell's Kitchen",
    nominees: [
      "Hell's Kitchen",       // Kecia Lewis (W) + Shoshana Bean
      'Cabaret at the Kit Kat Club', // Bebe Neuwirth (W)
      'Buena Vista Social Club', // Natalie Venetia Belcon
      'The Notebook',         // Dorian Harewood + Maryann Plunkett
      "Monty Python's Spamalot", // Leslie Rodriguez Kritzer
      'Teeth',                // Steven Pasquale
      'Dead Outlaw',          // Thom Sesma
      'Suffs',                // Emily Skinner
    ],
  },
  'Outstanding Direction of a Play': {
    winner: 'Stereophonic',
    nominees: [
      'Stereophonic',         // Daniel Aukin (W)
      'The Hunt',             // Rupert Goold
      'Purlie Victorious',    // Kenny Leon
      'Appropriate',          // Lila Neugebauer
      'Philadelphia, Here I Come!', // Ciarán O'Reilly
    ],
  },
  'Outstanding Direction of a Musical': {
    winner: 'Water for Elephants',
    nominees: [
      'Water for Elephants',  // Jessica Stone (W)
      'Dead Outlaw',          // David Cromer
      'Cabaret at the Kit Kat Club', // Rebecca Frecknall
      'The Connector',        // Daisy Prince
      'The Outsiders',        // Danya Taymor
    ],
  },
  'Outstanding Choreography': {
    winner: 'Illinoise',
    nominees: [
      'Illinoise',            // Justin Peck (W)
      "Hell's Kitchen",       // Camille A. Brown
      'The Gardens of Anuncia', // Graciela Daniele and Alex Sanchez
      'The Outsiders',        // Rick & Jeff Kuperman
      'The Heart of Rock and Roll', // Lorin Latarro
      'Water for Elephants',  // Jesse Robb and Shana Carroll
    ],
  },
  'Outstanding Music': {
    winner: 'Suffs',
    nominees: [
      'Suffs',                // Shaina Taub (W)
      'The Connector',        // Jason Robert Brown
      'Lizard Boy',           // Justin Huertas
      'The Outsiders',        // Jamestown Revival and Justin Levine
      'Dead Outlaw',          // David Yazbek and Erik Della Penna
    ],
  },
  'Outstanding Lyrics': {
    winner: 'Dead Outlaw',
    nominees: [
      'Dead Outlaw',          // David Yazbek and Erik Della Penna (W)
      'Rachel Bloom: Death, Let Me Do My Show', // Rachel Bloom, Eli Bolin, and Jack Dolgen
      'The Connector',        // Jason Robert Brown
      'Teeth',                // Michael R. Jackson
      'The Outsiders',        // Jamestown Revival and Justin Levine
    ],
  },
  'Outstanding Book of a Musical': {
    winner: 'Dead Outlaw',
    nominees: [
      'Dead Outlaw',          // Itamar Moses (W)
      'Lizard Boy',           // Justin Huertas
      'Teeth',                // Michael R. Jackson and Anna K. Jacobs
      'The Gardens of Anuncia', // Michael John LaChiusa
      'How to Dance in Ohio', // Rebekah Greer Melocik
    ],
  },
  'Outstanding Orchestrations': {
    winner: 'Buena Vista Social Club',
    nominees: [
      'Buena Vista Social Club', // Marco Paguia (W)
      'Illinoise',            // Timo Andres
      'Stereophonic',         // Will Butler and Justin Craig
      'The Greatest Hits Down Route 66', // Andy Evan Cohen
      'Dead Outlaw',          // Erik Della Penna, Dean Sharenow, and David Yazbek
      'Suffs',                // Michael Starobin, Shaina Taub, and Andrea Grody
    ],
  },
  'Outstanding Music in a Play': {
    winner: 'Stereophonic',
    nominees: [
      'Stereophonic',         // Will Butler (W)
      'The Effect',           // Michael "Mikey J" Asante
      '(pray)',               // S T A R R Busby and JJJJJerome Ellis
      'The Harriet Holland Social Club presentation', // Dionne McClain-Freeney
      'Pericles',             // Ben Steinfeld
    ],
  },
  'Outstanding Scenic Design of a Play': {
    winner: 'Stereophonic',
    nominees: [
      'Stereophonic',         // David Zinn (W)
      'The Hunt',             // Es Devlin
      'Appropriate',          // dots
      'Purlie Victorious',    // Derek McLane
      'Grey House',           // Scott Pask
    ],
  },
  'Outstanding Scenic Design of a Musical': {
    winner: 'The Great Gatsby',
    nominees: [
      'The Great Gatsby',     // Paul Tate DePoo III (W)
      'The Outsiders',        // AMP featuring Tatiana Kahvegian
      'Suffs',                // Riccardo Hernández
      'Dead Outlaw',          // Arnulfo Maldonado
      'Good Vibrations: A Punk Rock Musical', // Grace Smart
    ],
  },
  'Outstanding Costume Design of a Play': {
    winner: 'Stereophonic',
    nominees: [
      'Stereophonic',         // Enver Chakartash (W)
      'Macbeth (an undoing)', // Alex Berry
      'Warrior Sisters of Wu', // Karen Boyer
      'Manahatta',            // Lux Haac
      'Sally & Tom',          // Rodrigo Muñoz
    ],
  },
  'Outstanding Costume Design of a Musical': {
    winner: 'Suffs',
    nominees: [
      'Suffs',                // Paul Tazewell (W)
      'Buena Vista Social Club', // Dede Ayite
      'The Connector',        // Márion Talán de la Rosa
      'Once Upon a One More Time', // Loren Elstein
      'Water for Elephants',  // David Israel Reynoso
    ],
  },
  'Outstanding Lighting Design of a Play': {
    winner: 'Appropriate',
    nominees: [
      'Appropriate',          // Jane Cox (W)
      'Uncle Vanya',          // Stacey Derosier
      'Grey House',           // Natasha Katz
      'Macbeth (an undoing)', // Lizzie Powell
      'Swing State',          // Eric Southern
    ],
  },
  'Outstanding Lighting Design of a Musical': {
    winner: 'The Outsiders',
    nominees: [
      'The Outsiders',        // Brian MacDevitt and Hana S. Kim (W)
      'Suffs',                // Lap Chi Chu
      'Dead Outlaw',          // Heather Gilbert
      'Water for Elephants',  // Bradley King
      'The Connector',        // Jeanette Oi-Suk Yew
    ],
  },
  'Outstanding Sound Design of a Play': {
    winner: 'Stereophonic',
    nominees: [
      'Stereophonic',         // Ryan Rumery (W)
      'The Hunt',             // Adam Cork
      'Grey House',           // Tom Gibbons
      'The Comeuppance',      // Palmer Hefferan
      'Appropriate',          // Bray Poor and Will Pickens
    ],
  },
  'Outstanding Sound Design of a Musical': {
    winner: 'Cabaret at the Kit Kat Club',
    nominees: [
      'Cabaret at the Kit Kat Club', // Nick Lidster (W)
      'The Outsiders',        // Cody Spencer (W)
      'Water for Elephants',  // Walter Trarbach (W)
      'Suffs',                // Jason Crystal
      'Dead Outlaw',          // Kai Harada and Joshua Millican
    ],
  },
  'Outstanding Projection Design': {
    winner: "Hell's Kitchen",
    nominees: [
      "Hell's Kitchen",       // Peter Nigrini (W) — "Outstanding Projection and Video Design"
      'Our Class',            // Eric Dunlap
      'Russian Troll Farm: A Workplace Comedy', // Jared Mezzocchi
      'Melissa Etheridge: My Window', // Olivia Sebesky
      'The Connector',        // Jeanette Oi-Suk Yew
    ],
  },
  'Outstanding Solo Performance': {
    winner: 'All the Devils Are Here: How Shakespeare Invented the Villain',
    nominees: [
      'All the Devils Are Here: How Shakespeare Invented the Villain', // Patrick Page (W)
      'Sorry for Your Loss',  // Michael Cruz Kayne
      'Breathless',           // Madeleine MacMahon
      'Make Me Gorgeous!',    // Wade McCollum
      'SMALL',                // Robert Montano
    ],
  },
  'Outstanding Ensemble': {
    winner: 'Stereophonic',
    nominees: [
      'Stereophonic', // Cast of Stereophonic (special winner)
    ],
  },
};

function mergeIntoBaseline(baseline, year, perCategory) {
  const out = JSON.parse(JSON.stringify(baseline));
  for (const [cat, entry] of Object.entries(perCategory)) {
    const list = (out[cat] = out[cat] || []);
    const existing = list.find((e) => e.year === year);
    // De-dup nominees while preserving order.
    const dedupedNominees = [];
    const seen = new Set();
    for (const n of entry.nominees) {
      const key = n.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      dedupedNominees.push(n);
    }
    const sorted = [...dedupedNominees].sort();
    if (existing) {
      const union = new Set([...(existing.nominees || []), ...sorted]);
      existing.nominees = [...union].sort();
      if (entry.winner) existing.winner = entry.winner; // hand-typed source overrides
    } else {
      list.push({ year, winner: entry.winner, nominees: sorted });
      list.sort((a, b) => a.year - b.year);
    }
  }
  return out;
}

function summarize(baseline, merged, year) {
  let before = 0, after = 0;
  for (const list of Object.values(baseline)) {
    for (const e of list) if (e.year === year) before += (e.nominees || []).length;
  }
  for (const list of Object.values(merged)) {
    for (const e of list) if (e.year === year) after += (e.nominees || []).length;
  }
  return { before, after, delta: after - before };
}

function main() {
  const fp = path.join(PRECURSORS_DIR, 'drama-desk.json');
  const baseline = fs.existsSync(fp)
    ? JSON.parse(fs.readFileSync(fp, 'utf8')).data
    : {};

  let merged = JSON.parse(JSON.stringify(baseline));
  merged = mergeIntoBaseline(merged, 2023, DD_2023);
  merged = mergeIntoBaseline(merged, 2024, DD_2024);

  const sum23 = summarize(baseline, merged, 2023);
  const sum24 = summarize(baseline, merged, 2024);
  console.log(`\nPer-year nominee deltas:`);
  console.log(`  2023 (DD 67th): ${sum23.before} -> ${sum23.after} (+${sum23.delta})`);
  console.log(`  2024 (DD 68th): ${sum24.before} -> ${sum24.after} (+${sum24.delta})`);

  // Categories added (not in baseline)
  const newCats = Object.keys(merged).filter((c) => !baseline[c]);
  console.log(`\nNew categories added: ${newCats.length}`);
  for (const c of newCats) console.log(`  + ${c}`);

  writePrecursorJson('drama-desk', merged, {
    force: true,
    dryRun: !WRITE,
    meta: {
      sources: {
        'DD 67th (2023)': 'https://www.broadwayworld.com/article/SOME-LIKE-IT-HOT-PARADE-and-More-Take-Home-2023-Drama-Desk-Awards-Full-List-of-Winners-20230531',
        'DD 68th (2024)': 'https://www.broadwayworld.com/article/2024-Drama-Desk-Awards-Winners--Updating-Live-20240610',
      },
      transcribedAt: new Date().toISOString(),
      mergeMode: 'hand-typed-union',
    },
  });

  if (!WRITE) console.log('\n(dry-run; pass --write to commit)');
}

main();
