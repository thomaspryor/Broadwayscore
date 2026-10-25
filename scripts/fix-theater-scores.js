#!/usr/bin/env node
/**
 * Fix theater scores and summaries based on audit findings.
 * Run: node scripts/fix-theater-scores.js
 */

const fs = require('fs');
const METADATA_PATH = 'data/theater-metadata.json';
const metadata = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'));

// === SCORE CHANGES ===
const scoreChanges = {
  "Broadhurst Theatre": { comfort: 1 },
  "Marquis Theatre": { ambiance: 1 },
  "Winter Garden Theatre": { sightlines: 3 },
  "Gershwin Theatre": { sightlines: 3, comfort: 3 },
  "Studio 54": { ambiance: 4 },
  "Palace Theatre": { sound: 4, comfort: 4 },
  "St. James Theatre": { ambiance: 5 },
  "Lyceum Theatre": { ambiance: 5 },
  "Hudson Theatre": { ambiance: 5 },
  "Helen Hayes Theater": { ambiance: 4 },
  "Booth Theatre": { comfort: 4 },
  "Stephen Sondheim Theatre": { comfort: 4 },
  "Lyric Theatre": { ambiance: 3 },
  "Lunt-Fontanne Theatre": { comfort: 2 },
  "Majestic Theatre": { ambiance: 3 },
};

// === SUMMARY REWRITES ===
const summaryRewrites = {
  "Richard Rodgers Theatre": "The Richard Rodgers offers strong sightlines from most orchestra and front mezzanine seats, with good acoustics for musicals. However, legroom is notably tight throughout, especially in the orchestra, and rear mezzanine seats feel distant from the stage.",
  "Harold and Miriam Steinberg Center for Theatre": "An intimate 299-seat black box space at Roundabout, offering an unusually close actor-audience experience unlike any other Broadway house. Sightlines and sound vary by configuration since staging changes per production. Comfort is adequate but unremarkable.",
  "Helen Hayes Theater": "One of Broadway's smallest houses (597 seats) and one of its newest, built in 2015 as Second Stage's permanent home. The intimate scale means excellent sightlines from nearly every seat, though the modern design prioritizes function over grandeur.",
  "Lunt-Fontanne Theatre": "A handsome Art Deco house with a distinctive celestial ceiling and wide auditorium. Sightlines are good from center seats but the wide layout means far-side seats lose some stage width. Notoriously narrow seats make comfort a challenge for longer shows.",
  "Palace Theatre": "Spectacularly renovated in a $100M+ project that literally raised the theater 30 feet. The restoration preserved its opulent 1913 interior while upgrading acoustics, seating comfort, and accessibility — one of the best-equipped houses on Broadway.",
  "Circle in the Square Theatre": "Broadway's only thrust-stage theater offers an unmatched intimate experience — no seat is more than a few rows from the action. Sightlines are excellent from every angle, though some seats face actors' backs during certain scenes.",
  "Studio 54": "The legendary former nightclub retains a distinctive atmosphere even in its theatrical configuration. The cavernous space creates an unusual energy, though comfort suffers from tight legroom in both orchestra and mezzanine sections.",
  "Minskoff Theatre": "A modern, well-equipped theater with clean sightlines from most sections. The contemporary design lacks the ornate character of older Broadway houses but delivers reliable sound and adequate comfort. Home to The Lion King since 2006.",
  "Gershwin Theatre": "Broadway's largest theater (1,933 seats) delivers spectacle but the sheer size means rear orchestra and mezzanine seats feel very far from the stage. Sound systems compensate for the distance but intimacy is sacrificed. Legroom is average despite the theater's scale.",
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

for (const [name, summary] of Object.entries(summaryRewrites)) {
  if (!metadata[name]?.venueScores) {
    console.log('MISSING:', name);
    continue;
  }
  const old = (metadata[name].venueScores.summary || '').substring(0, 40) + '...';
  metadata[name].venueScores.summary = summary;
  console.log(`Summary: ${name} rewritten (was: ${old})`);
  changeCount++;
}

const tmpPath = METADATA_PATH + '.tmp';
fs.writeFileSync(tmpPath, JSON.stringify(metadata, null, 2) + '\n');
fs.renameSync(tmpPath, METADATA_PATH);
console.log(`\n${changeCount} changes applied`);
