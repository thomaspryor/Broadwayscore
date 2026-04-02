#!/usr/bin/env node
/**
 * Round 2 theater score fixes — based on consensus across 5 independent reviews:
 * Original Claude audit, GPT-4o, Gemini, Consumer UX review, Reddit/forum research
 *
 * Only applies changes with 2+ reviewer agreement or strong Reddit evidence.
 */

const fs = require('fs');
const METADATA_PATH = 'data/theater-metadata.json';
const metadata = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'));

// === SCORE CHANGES (consensus 2+ reviewers or strong evidence) ===
const scoreChanges = {
  // Booth comfort 4→3: Original+Gemini+Reddit all say "tight" contradicts 4
  "Booth Theatre": { comfort: 3 },

  // Hudson comfort 3→4: Reddit confirms "widest, most comfortable seats on Broadway"
  "Hudson Theatre": { comfort: 4 },

  // Palace facilities 3→4: Reddit+Playbill #1 bathrooms, $100M renovation
  // Palace comfort 4→5: Gemini says "one of the best-equipped" warrants 5
  "Palace Theatre": { facilities: 4, comfort: 5 },

  // James Earl Jones facilities 3→4: Reddit+Playbill #3 bathrooms, 5-story annex
  "James Earl Jones Theatre": { facilities: 4 },

  // Stephen Sondheim facilities 3→4: Reddit+Playbill #4 bathrooms, 30 stalls
  "Stephen Sondheim Theatre": { facilities: 4 },

  // Nederlander sightlines 4→3: Reddit confirms no rake, horizontal bar obstructions
  "Nederlander Theatre": { sightlines: 3 },

  // Studio 54 comfort 2→1: Reddit "worst seats on Broadway", steep dangerous rear mezz
  "Studio 54": { comfort: 1 },

  // Todd Haimes comfort 3→4, facilities 3→4: 2025-26 renovation replaced all seats + restrooms
  "Todd Haimes Theatre": { comfort: 4, facilities: 4 },

  // Helen Hayes comfort 3→4: Gemini+UX agree newest theater deserves higher
  "Helen Hayes Theater": { comfort: 4 },
};

// === SUMMARY ENHANCEMENTS (add specific warnings/tips from Reddit) ===
const summaryEnhancements = {
  "Studio 54": "The legendary former nightclub retains a distinctive atmosphere even in its theatrical configuration. However, comfort is among the worst on Broadway — the rear mezzanine is extremely steep with limited guardrails and tight legroom throughout both levels.",

  "Palace Theatre": "Spectacularly renovated in a $100M+ project that literally raised the theater 30 feet. The restoration preserved its opulent 1913 interior while upgrading acoustics, seating comfort, and best-in-class restrooms on every level — widely considered the best facilities on Broadway.",

  "Nederlander Theatre": "An older theater in need of renovation, with virtually no rake in the orchestra — a tall person seated in front will block your view. First mezzanine row has a horizontal safety bar that partially obstructs sightlines. Legroom is tight throughout.",

  "James Earl Jones Theatre": "A beautifully restored theater with a stunning Tiffany-inspired interior. The 2021 renovation transformed restroom facilities from among Broadway's worst to a model for the industry, with modern bathrooms on every public level.",

  "Stephen Sondheim Theatre": "A Roundabout Theatre Company house with excellent sightlines and good sound. Post-renovation seating is comfortable with decent legroom. Standout facilities include 30 women's restroom stalls — triple the building code requirement — virtually eliminating intermission lines.",

  "Todd Haimes Theatre": "Completed a major renovation in early 2026 with all seats replaced, legroom expanded, new restrooms, and elevator access to all levels. One of Broadway's most accessible and comfortable houses thanks to the recent upgrades.",

  "Broadhurst Theatre": "One of Broadway's least comfortable theaters, with notoriously tight legroom and narrow seats. The lack of rake means tall patrons in front block your view. Restrooms are in the basement, creating long intermission lines. For legroom, target Row A or N in Orchestra.",

  "Hudson Theatre": "A beautifully restored 1903 gem — one of the most gorgeous small theaters on Broadway. The 2017 renovation delivered some of the widest and most comfortable seats in the Theater District, with excellent sightlines from the intimate 970-seat house.",
};

let changeCount = 0;

for (const [name, changes] of Object.entries(scoreChanges)) {
  if (!metadata[name]?.venueScores) {
    console.log('MISSING:', name);
    continue;
  }
  for (const [dim, val] of Object.entries(changes)) {
    const old = metadata[name].venueScores[dim];
    metadata[name].venueScores[dim] = val;
    console.log(`Score: ${name} ${dim} ${old} -> ${val}`);
    changeCount++;
  }
}

for (const [name, summary] of Object.entries(summaryEnhancements)) {
  if (!metadata[name]?.venueScores) {
    console.log('MISSING:', name);
    continue;
  }
  metadata[name].venueScores.summary = summary;
  console.log(`Summary: ${name} updated`);
  changeCount++;
}

const tmpPath = METADATA_PATH + '.tmp';
fs.writeFileSync(tmpPath, JSON.stringify(metadata, null, 2) + '\n');
fs.renameSync(tmpPath, METADATA_PATH);
console.log(`\n${changeCount} changes applied`);
