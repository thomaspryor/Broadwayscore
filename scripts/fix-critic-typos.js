#!/usr/bin/env node
/**
 * fix-critic-typos.js
 *
 * Fixes critic name typo variants in review-texts/.
 * For each typo pair (same outlet, same show, Levenshtein 1-2):
 *   - Determines the correct critic spelling (most reviews, or known canonical)
 *   - Flags the typo file with wrongAttribution: true
 *   - If the correct file is missing data the typo has, merges it
 *
 * Usage:
 *   node scripts/fix-critic-typos.js              # Dry run (default)
 *   node scripts/fix-critic-typos.js --apply       # Apply fixes
 */

const fs = require('fs');
const path = require('path');

const DATA_ROOT = process.argv.find(a => a.startsWith('--data-dir='))
  ? process.argv.find(a => a.startsWith('--data-dir=')).replace('--data-dir=', '')
  : path.join(__dirname, '..', 'data');
const DIR = path.join(DATA_ROOT, 'review-texts');
const DRY_RUN = !process.argv.includes('--apply');

// Known canonical critic name spellings (slug -> canonical slug)
const CANONICAL_NAMES = {
  'elizabeth-vincentelli': 'elisabeth-vincentelli',  // NYT uses Elisabeth
  'david-quinn': 'dave-quinn',  // NBC NY byline is Dave
  'marylin-stasio': 'marilyn-stasio',
  'franck-scheck': 'frank-scheck',
  'frank-sheck': 'frank-scheck',
  'lovia-gayarkye': 'lovia-gyarkye',
  'love-gyarkye': 'lovia-gyarkye',
  'sarah-holdren': 'sara-holdren',
  'sara-holden': 'sara-holdren',
  'jessie-green': 'jesse-green',
  'roberth-kahn': 'robert-kahn',
  'davide-cote': 'david-cote',
  'alive-saville': 'alice-saville',
  'andrjez-lukowski': 'andrzej-lukowski',
  'nick-curits': 'nick-curtis',
  'diana-snyder': 'diane-snyder',
  'matt-windham': 'matt-windman',
  'brandan-lemon': 'brendan-lemon',
  'michael-glitz': 'michael-giltz',
  'barbra-schuler': 'barbara-schuler',
  'alex-soloski': 'alexis-soloski',
  'kerenssa-cadenas': 'kerensa-cardenas',
  'aliya-al-hussan': 'aliya-al-hassan',
  'brian-scot-lipton': 'brian-scott-lipton',
  'micael-j-fressola': 'michael-j-fressola',
  'ron-taub': 'rob-taub',
  'chales-mcnulty': 'charles-mcnulty',
  'charles-ishwerwood': 'charles-isherwood',
  'clark-collins': 'clark-collis',
  'leah-greenblat': 'leah-greenblatt',
  'thom-geir': 'thom-geier',
  'allison-adato': 'alison-adato', // EW uses Alison
  'ronni-reich': 'ronnie-reich',
  'pete-hempstead': 'peter-hempstead',
  'haley-levitt': 'hayley-levitt',
  'bedatri-dchoudhury': 'bedatri-d-choudhury',
  'claire-alfree': 'claire-allfree',
  'elyssa-garner': 'elysa-gardner',
  'ar-hoffman': 'a-r-hoffman',
  'j-kelly-nestruck': 'kelly-nestruck',
  'tom-geier': 'thom-geier',
};

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({length: m+1}, (_,i) =>
    Array.from({length: n+1}, (_,j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1] + (a[i-1]===b[j-1]?0:1));
  return d[m][n];
}

// Build global critic frequency map for tiebreaking
function buildCriticFrequency() {
  const freq = {};
  const showDirs = fs.readdirSync(DIR).filter(d =>
    fs.statSync(path.join(DIR, d)).isDirectory()
  );
  for (const showId of showDirs) {
    const showDir = path.join(DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    for (const file of files) {
      const m = file.replace('.json', '').match(/^(.+?)--(.+)$/);
      if (!m) continue;
      const key = m[1] + '/' + m[2];
      freq[key] = (freq[key] || 0) + 1;
      // Also track just critic slug
      freq['critic:' + m[2]] = (freq['critic:' + m[2]] || 0) + 1;
    }
  }
  return freq;
}

function determineCorrectCritic(a, b, outlet, freq) {
  // 1. Check canonical names
  if (CANONICAL_NAMES[a] === b) return b;
  if (CANONICAL_NAMES[b] === a) return a;
  if (CANONICAL_NAMES[a]) return CANONICAL_NAMES[a];
  if (CANONICAL_NAMES[b]) return CANONICAL_NAMES[b];

  // 2. Use global frequency at this outlet
  const freqA = freq[outlet + '/' + a] || 0;
  const freqB = freq[outlet + '/' + b] || 0;
  if (freqA > freqB) return a;
  if (freqB > freqA) return b;

  // 3. Use global critic frequency
  const cFreqA = freq['critic:' + a] || 0;
  const cFreqB = freq['critic:' + b] || 0;
  if (cFreqA > cFreqB) return a;
  if (cFreqB > cFreqA) return b;

  // 4. Longer name is usually more correct (has full first name)
  if (a.length > b.length) return a;
  return b;
}

function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== APPLYING FIXES ===');
  console.log('Building critic frequency map...');
  const freq = buildCriticFrequency();

  const showDirs = fs.readdirSync(DIR).filter(d =>
    fs.statSync(path.join(DIR, d)).isDirectory()
  );

  let fixed = 0;
  let skipped = 0;

  for (const showId of showDirs) {
    const showDir = path.join(DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    const parsed = files.map(f => {
      const m = f.replace('.json', '').match(/^(.+?)--(.+)$/);
      return m ? { file: f, outlet: m[1], critic: m[2] } : null;
    }).filter(Boolean);

    const byOutlet = {};
    for (const p of parsed) {
      if (!byOutlet[p.outlet]) byOutlet[p.outlet] = [];
      byOutlet[p.outlet].push(p);
    }

    for (const [outlet, entries] of Object.entries(byOutlet)) {
      if (entries.length < 2) continue;
      for (let i = 0; i < entries.length; i++) {
        for (let j = i+1; j < entries.length; j++) {
          const dist = levenshtein(entries[i].critic, entries[j].critic);
          if (dist < 1 || dist > 2) continue;

          // Read both files
          let dataI, dataJ;
          try {
            dataI = JSON.parse(fs.readFileSync(path.join(showDir, entries[i].file), 'utf8'));
            dataJ = JSON.parse(fs.readFileSync(path.join(showDir, entries[j].file), 'utf8'));
          } catch { continue; }

          if (dataI.wrongAttribution || dataJ.wrongAttribution) { skipped++; continue; }
          if (dataI.wrongProduction || dataI.wrongShow) { skipped++; continue; }
          if (dataJ.wrongProduction || dataJ.wrongShow) { skipped++; continue; }

          const correct = determineCorrectCritic(entries[i].critic, entries[j].critic, outlet, freq);
          const typoEntry = correct === entries[i].critic ? entries[j] : entries[i];
          const correctEntry = correct === entries[i].critic ? entries[i] : entries[j];
          const typoData = correct === entries[i].critic ? dataJ : dataI;
          const correctData = correct === entries[i].critic ? dataI : dataJ;

          console.log(`${showId}/${outlet}: ${typoEntry.critic} → ${correctEntry.critic} (dist=${dist})`);

          if (!DRY_RUN) {
            // Flag the typo file
            typoData.wrongAttribution = true;
            typoData.wrongAttributionReason = `Typo of ${correctEntry.critic} (Levenshtein ${dist})`;
            fs.writeFileSync(path.join(showDir, typoEntry.file), JSON.stringify(typoData, null, 2) + '\n');

            // If correct file is missing data the typo had, merge key fields
            if (!correctData.url && typoData.url) correctData.url = typoData.url;
            if (!correctData.publishDate && typoData.publishDate) correctData.publishDate = typoData.publishDate;
            if (!correctData.fullText && typoData.fullText) {
              correctData.fullText = typoData.fullText;
              correctData.textWordCount = typoData.textWordCount;
              correctData.textFetchedAt = typoData.textFetchedAt;
              correctData.fetchMethod = typoData.fetchMethod;
              correctData.textStatus = typoData.textStatus;
              correctData.textQuality = typoData.textQuality;
              correctData.contentTier = typoData.contentTier;
              correctData.contentTierReason = typoData.contentTierReason;
            }
            fs.writeFileSync(path.join(showDir, correctEntry.file), JSON.stringify(correctData, null, 2) + '\n');
          }

          fixed++;
        }
      }
    }
  }

  console.log(`\n${DRY_RUN ? 'Would fix' : 'Fixed'}: ${fixed} typo pairs`);
  console.log(`Skipped: ${skipped} (already flagged)`);
}

main();
