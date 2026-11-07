#!/usr/bin/env node
/**
 * One-time backfill: discover and store correct platform URLs in audience-buzz.json.
 * Tests slug variants against each platform and saves the first working URL.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadAudienceBuzz, saveAudienceBuzz } = require('./lib/audience-buzz-write-guard');

const showsPath = path.join(__dirname, '../data/shows.json');

const buzz = loadAudienceBuzz();
const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows;
const showMap = {};
for (const s of shows) showMap[s.id] = s;

function titleToSlug(title) {
  return title.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-').replace(/-+/g, '-').trim();
}

function buildVariants(title) {
  const base = titleToSlug(title);
  const variants = new Set([base]);
  
  // Drop common suffixes
  for (const suffix of ['-the-musical', '-both-parts', '-on-stage', '-the-classic-story-on-stage',
    '-at-the-kit-kat-club', '-the-first-shadow', '-a-comedy-by-florian-zeller',
    '-an-improvised-jane-austen-novel', '-the-untold-story-of-ursula-the-sea-witch',
    '-new-wimbledon-theatre', '-and-the-merry-mandem']) {
    if (base.endsWith(suffix)) variants.add(base.replace(new RegExp(suffix + '$'), ''));
  }
  
  // Drop '-globe' suffix (Shakespeare's Globe shows)
  if (base.endsWith('-globe')) variants.add(base.replace(/-globe$/, ''));
  
  // Drop leading 'the-'
  for (const v of [...variants]) {
    if (v.startsWith('the-')) variants.add(v.replace(/^the-/, ''));
  }
  
  // First 2-3 words for long slugs
  const parts = base.split('-');
  if (parts.length > 4) {
    variants.add(parts.slice(0, 2).join('-'));
    variants.add(parts.slice(0, 3).join('-'));
  }
  
  variants.delete('');
  return [...variants];
}

function checkUrl(url) {
  return new Promise(resolve => {
    const req = https.get(url, { timeout: 10000 }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PLATFORMS = {
  seatplan: slug => `https://seatplan.com/london/${slug}-tickets/`,
  lbo: slug => `https://www.londonboxoffice.co.uk/${slug}-tickets`,
  ltd: slug => `https://www.londontheatredirect.com/musical/${slug}-tickets`,
};

async function main() {
  let found = 0, tested = 0, alreadyHave = 0;

  for (const [showId, data] of Object.entries(buzz.shows)) {
    const show = showMap[showId];
    if (!show) continue;
    
    for (const [key, urlFn] of Object.entries(PLATFORMS)) {
      const source = data.sources[key];
      if (!source || source.score == null) continue;
      if (source.url) { alreadyHave++; continue; }
      
      const variants = buildVariants(show.title);
      let foundUrl = null;
      
      for (const slug of variants) {
        const url = urlFn(slug);
        tested++;
        const status = await checkUrl(url);
        if (status === 200 || status === 301) {
          foundUrl = url;
          break;
        }
        await sleep(200); // Rate limit
      }
      
      if (foundUrl) {
        source.url = foundUrl;
        found++;
        console.log(`✅ ${show.title} [${key}]: ${foundUrl}`);
      } else {
        console.log(`❌ ${show.title} [${key}]: no working URL found`);
      }
    }
  }

  saveAudienceBuzz(buzz);
  console.log(`\nDone: ${found} URLs found, ${alreadyHave} already had URLs, ${tested} requests made`);
}

main().catch(console.error);
