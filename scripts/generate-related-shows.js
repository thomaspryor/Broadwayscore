#!/usr/bin/env node

/**
 * Generate LLM-powered related show recommendations
 *
 * Hybrid approach: algorithmic pre-filter (top 15) → LLM re-rank (pick 6)
 * Batches 10 shows per LLM call for cost efficiency (~$0.05-0.10 total)
 *
 * Provider chain: GPT-4o-mini (primary) → Gemini Flash (fallback)
 *
 * Usage:
 *   node scripts/generate-related-shows.js              # Full run (new + stale)
 *   node scripts/generate-related-shows.js --force       # Regenerate all
 *   node scripts/generate-related-shows.js --show=hamilton  # Single show
 *   node scripts/generate-related-shows.js --max=200     # Cap at 200 shows (new first)
 *   node scripts/generate-related-shows.js --dry-run     # Print without saving
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { GPT4O_MINI, GEMINI_FLASH } = require('./lib/models');

const ROOT = path.resolve(__dirname, '..');
const SHOWS_FILE = path.join(ROOT, 'data', 'shows.json');
const CONSENSUS_FILE = path.join(ROOT, 'data', 'critic-consensus.json');
const REVIEWS_FILE = path.join(ROOT, 'data', 'reviews.json');
const OUTPUT_FILE = path.join(ROOT, 'data', 'related-shows.json');

// Parse CLI args
const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const maxShows = parseInt(args.find(a => a.startsWith('--max='))?.split('=')[1] || '0', 10) || 0;

// Meta tags to strip from LLM input (not useful for recommendations)
const META_TAGS = new Set(['lottery', 'rush', 'sro', 'tony-winner', 'new', 'classic', 'limited-run', 'upcoming']);

// ─── Comparison pairs (hard constraints) ───
// Imported inline since this is CJS and comparisons.ts is ESM
const COMPARISON_PAIRS = [
  ['hamilton', 'wicked'], ['the-lion-king', 'aladdin'], ['the-lion-king', 'wicked'],
  ['hamilton', 'the-lion-king'], ['wicked', 'aladdin'], ['hamilton', 'moulin-rouge'],
  ['chicago', 'moulin-rouge'], ['chicago', 'wicked'], ['chicago', 'hamilton'],
  ['the-lion-king', 'moulin-rouge'], ['book-of-mormon', 'hamilton'], ['book-of-mormon', 'wicked'],
  ['hadestown', 'moulin-rouge'], ['hadestown', 'wicked'], ['hadestown', 'hamilton'],
  ['six', 'hadestown'], ['six', 'and-juliet'], ['mj', 'hadestown'], ['mj', 'moulin-rouge'],
  ['the-lion-king', 'harry-potter'], ['aladdin', 'the-lion-king'], ['aladdin', 'harry-potter'],
  ['wicked', 'harry-potter'], ['the-lion-king', 'mj'], ['aladdin', 'mj'],
  ['the-outsiders', 'water-for-elephants'], ['hells-kitchen', 'the-outsiders'],
  ['hells-kitchen', 'hadestown'], ['the-great-gatsby', 'moulin-rouge'],
  ['death-becomes-her', 'chicago'], ['oh-mary', 'cabaret-2024'],
  ['maybe-happy-ending', 'the-notebook'], ['stranger-things', 'beetlejuice-2019'],
  ['mj', 'six'], ['and-juliet', 'mj'], ['and-juliet', 'moulin-rouge'],
  ['harry-potter', 'stranger-things'], ['stereophonic', 'appropriate'],
  ['death-of-a-salesman', 'oedipus'], ['cabaret-2024', 'chicago'],
  ['sweeney-todd-2023', 'hadestown'], ['sunset-boulevard-2024', 'chicago'],
  ['sunset-boulevard-2024', 'cabaret-2024'], ['hamilton', 'harry-potter'],
  ['wicked', 'stranger-things'], ['the-phantom-of-the-opera-1988', 'les-miserables-2014'],
  ['rent-1996', 'dear-evan-hansen-2016'], ['come-from-away-2017', 'dear-evan-hansen-2016'],
  ['jersey-boys-2005', 'mj'], ['mean-girls-2018', 'six'], ['frozen-2018', 'aladdin'],
  ['beetlejuice-2019', 'mean-girls-2018'],
];

// Build slug→slug comparison map
const comparisonMap = new Map();
for (const [a, b] of COMPARISON_PAIRS) {
  if (!comparisonMap.has(a)) comparisonMap.set(a, []);
  if (!comparisonMap.has(b)) comparisonMap.set(b, []);
  comparisonMap.get(a).push(b);
  comparisonMap.get(b).push(a);
}

// ─── Load data ───
const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
const consensusData = fs.existsSync(CONSENSUS_FILE) ? JSON.parse(fs.readFileSync(CONSENSUS_FILE, 'utf8')) : { shows: {} };
const reviewsData = JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));

// Build lookup maps
const showById = new Map();
const showBySlug = new Map();
const idToSlug = new Map();
const slugToId = new Map();
for (const s of showsData.shows) {
  showById.set(s.id, s);
  showBySlug.set(s.slug, s);
  idToSlug.set(s.id, s.slug);
  slugToId.set(s.slug, s.id);
}

// Build review count map
const reviewCountMap = new Map();
for (const r of reviewsData.reviews) {
  const count = reviewCountMap.get(r.showId) || 0;
  reviewCountMap.set(r.showId, count + 1);
}

// Build score map
const scoreMap = new Map();
for (const s of showsData.shows) {
  // Compute a simple average from reviews
  const showReviews = reviewsData.reviews.filter(r => r.showId === s.id && r.assignedScore != null);
  if (showReviews.length >= 5) {
    const avg = showReviews.reduce((sum, r) => sum + r.assignedScore, 0) / showReviews.length;
    scoreMap.set(s.id, Math.round(avg));
  }
}

// ─── Algorithmic pre-filter (matches data-core.ts logic) ───
// statusFilter: 'open' = open/previews only, 'closed' = closed only, null = all
function getMarket(show) {
  const cat = show.category || 'broadway';
  // Group by city: Broadway + Off-Broadway = "nyc", West End + Off-West End = "london"
  if (cat === 'broadway' || cat === 'off-broadway') return 'nyc';
  if (cat === 'west-end' || cat === 'off-west-end') return 'london';
  return cat;
}

function algorithmicCandidates(show, limit = 15, statusFilter = null) {
  const currentCreatives = new Map();
  for (const m of show.creativeTeam || []) {
    currentCreatives.set(m.name.toLowerCase(), m.role.toLowerCase());
  }
  const currentTags = new Set((show.tags || []).filter(t => !META_TAGS.has(t)));
  const currentYear = show.openingDate ? new Date(show.openingDate).getFullYear() : 2020;
  const currentScore = scoreMap.get(show.id) ?? null;
  const currentMarket = getMarket(show);

  const getBand = (score) => {
    if (score === null) return -1;
    if (score >= 90) return 3;
    if (score >= 75) return 2;
    if (score >= 60) return 1;
    return 0;
  };
  const currentBand = getBand(currentScore);

  const thematicTags = new Set(['comedy', 'drama', 'romantic', 'family', 'fantasy', 'thriller', 'biographical']);
  const structuralTags = new Set(['jukebox', 'immersive', 'one-person-show', 'concert', 'revue']);

  const roleWeight = (role) => {
    const r = role.toLowerCase();
    if (r === 'director') return 8;
    if (['book', 'playwright', 'composer', 'music', 'lyrics', 'lyricist'].includes(r)) return 7;
    if (r === 'choreographer') return 5;
    return 2;
  };

  const isOpen = (s) => s.status === 'open' || s.status === 'previews';

  const sourceBase = getBaseTitle(show.title);

  const scored = showsData.shows
    .filter(s => {
      if (s.id === show.id) return false;
      if (getBaseTitle(s.title) === sourceBase) return false; // Exclude other productions of same show
      if ((reviewCountMap.get(s.id) || 0) < 5) return false;
      if (getMarket(s) !== currentMarket) return false; // Same market only (matches data-core.ts)
      if (statusFilter === 'open' && !isOpen(s)) return false;
      if (statusFilter === 'closed' && isOpen(s)) return false;
      return true;
    })
    .map(candidate => {
      let score = 0;
      if (candidate.type === show.type) score += 10;
      for (const member of candidate.creativeTeam || []) {
        if (currentCreatives.has(member.name.toLowerCase())) {
          score += roleWeight(member.role);
        }
      }
      for (const tag of (candidate.tags || []).filter(t => !META_TAGS.has(t))) {
        if (!currentTags.has(tag)) continue;
        if (thematicTags.has(tag)) score += 4;
        else if (structuralTags.has(tag)) score += 2;
      }
      const candidateBand = getBand(scoreMap.get(candidate.id) ?? null);
      if (currentBand >= 0 && candidateBand >= 0) {
        if (candidateBand === currentBand) score += 3;
        else if (Math.abs(candidateBand - currentBand) === 1) score += 1;
      }
      const candidateYear = candidate.openingDate ? new Date(candidate.openingDate).getFullYear() : 2020;
      const yearDiff = Math.abs(currentYear - candidateYear);
      if (yearDiff <= 2) score += 3;
      else if (yearDiff <= 5) score += 1;
      if (isOpen(candidate)) score += 3;

      return { show: candidate, score };
    })
    .filter(({ score }) => score >= 8)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(s => s.show);
}

// ─── LLM Providers ───
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function callOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: GPT4O_MINI,
      temperature: 0.3,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const req = https.request('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          const json = JSON.parse(data);
          resolve(json.choices?.[0]?.message?.content || '');
        } else {
          reject(new Error(`OpenAI ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH}:generateContent?key=${apiKey}`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } }
    });

    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          const json = JSON.parse(data);
          resolve(json.candidates?.[0]?.content?.parts?.[0]?.text || '');
        } else {
          reject(new Error(`Gemini ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callLLM(prompt) {
  const providers = [];
  if (process.env.OPENAI_API_KEY) providers.push({ name: 'openai', call: callOpenAI });
  if (process.env.GEMINI_API_KEY) providers.push({ name: 'gemini', call: callGemini });

  for (const { name, call } of providers) {
    try {
      const text = await call(prompt);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return { parsed, provider: name };
      }
      // Try array format
      const arrayMatch = text.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        return { parsed: JSON.parse(arrayMatch[0]), provider: name };
      }
    } catch (e) {
      console.log(`  ${name} failed: ${e.message}`);
    }
  }
  return null;
}

// ─── Build show profile for LLM ───
function buildShowProfile(show) {
  const score = scoreMap.get(show.id);
  const consensus = consensusData.shows[show.id]?.text || '';
  const tags = (show.tags || []).filter(t => !META_TAGS.has(t));
  const director = (show.creativeTeam || []).find(m => m.role === 'Director')?.name || '';
  const writers = (show.creativeTeam || [])
    .filter(m => ['Book', 'Playwright', 'Composer', 'Music', 'Lyrics', 'Lyricist', 'Music & Lyrics'].includes(m.role))
    .map(m => `${m.name} (${m.role})`)
    .join(', ');

  return [
    `TITLE: ${show.title}`,
    `TYPE: ${show.type} | STATUS: ${show.status} | SCORE: ${score || 'N/A'}/100`,
    tags.length ? `TAGS: ${tags.join(', ')}` : '',
    director ? `DIRECTOR: ${director}` : '',
    writers ? `WRITERS: ${writers}` : '',
    show.synopsis ? `SYNOPSIS: ${show.synopsis.slice(0, 200)}` : '',
    consensus ? `CRITICAL CONSENSUS: ${consensus}` : '',
  ].filter(Boolean).join('\n');
}

function buildCandidateList(candidates) {
  return candidates.map(c => {
    const score = scoreMap.get(c.id);
    const consensus = consensusData.shows[c.id]?.text || '';
    const tags = (c.tags || []).filter(t => !META_TAGS.has(t));
    const director = (c.creativeTeam || []).find(m => m.role === 'Director')?.name || '';
    const parts = [
      `ID: ${c.id} | "${c.title}" | ${c.type} | ${c.status} | score:${score || '?'}`,
    ];
    if (tags.length) parts.push(`  tags: ${tags.join(', ')}`);
    if (director) parts.push(`  director: ${director}`);
    if (consensus) parts.push(`  consensus: ${consensus.slice(0, 150)}`);
    return parts.join('\n');
  }).join('\n\n');
}

// ─── Build batch prompt ───
function buildBatchPrompt(batch, pool) {
  // pool: 'open' or 'closed'
  // batch = [{ show, openCandidates, closedCandidates, comparisonIds }]
  const candidates = pool === 'open' ? 'openCandidates' : 'closedCandidates';
  const poolLabel = pool === 'open' ? 'CURRENTLY OPEN/PREVIEWS' : 'CLOSED';

  let prompt = `You are a Broadway recommendation engine. For each show below, pick the 6 best "if you liked this, you'd also like..." recommendations from its candidate list.

ALL candidates are ${poolLabel} shows. Pick the 6 best matches.

RULES:
- Consider tone, vibe, creative team connections, audience overlap, and genre feel
- Do NOT just match on type — a dark irreverent comedy fan doesn't want a family musical
- Never recommend two productions of the same title
- Some shows have "MUST INCLUDE" IDs — these are editorially curated comparisons that MUST appear in the 6 (fill remaining slots from candidates)

Return a JSON object mapping each show's ID to an array of 6 recommended IDs:
{
  "show-id-1": ["rec-1", "rec-2", "rec-3", "rec-4", "rec-5", "rec-6"],
  "show-id-2": ["rec-1", "rec-2", "rec-3", "rec-4", "rec-5", "rec-6"]
}

Return ONLY the JSON object, no other text.\n\n`;

  for (const item of batch) {
    const show = item.show;
    const cands = item[candidates];
    if (cands.length === 0) continue;

    // Filter comparison IDs to ones in this pool
    const candIds = new Set(cands.map(c => c.id));
    const poolCompIds = (item.comparisonIds || []).filter(id => candIds.has(id));

    prompt += `═══ SHOW: ${show.id} ═══\n`;
    prompt += buildShowProfile(show) + '\n';
    if (poolCompIds.length > 0) {
      prompt += `MUST INCLUDE (up to 2): ${poolCompIds.join(', ')}\n`;
    }
    prompt += `\nCANDIDATES:\n${buildCandidateList(cands)}\n\n`;
  }

  return prompt;
}

// ─── Multi-production dedup ───
function getBaseTitle(title) {
  return title.toLowerCase().replace(/\s*\(\d{4}\)\s*$/, '').trim();
}

function deduplicateProductions(ids, sourceShow) {
  // Extract base title (remove year suffix)
  const sourceBase = getBaseTitle(sourceShow.title);
  const seen = new Map(); // baseTitle → id
  const result = [];
  for (const id of ids) {
    const show = showById.get(id);
    if (!show) continue;
    const base = getBaseTitle(show.title);
    // Exclude other productions of the same show
    if (base === sourceBase) continue;
    if (seen.has(base)) continue;
    seen.set(base, id);
    result.push(id);
  }
  return result;
}

// ─── Main ───
async function main() {
  console.log('=== Generate Related Shows (Hybrid LLM) ===');
  console.log(`Shows: ${showsData.shows.length} | Consensus: ${Object.keys(consensusData.shows).length}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'} | Force: ${force} | Filter: ${showFilter || 'all'}`);

  // Load existing data
  let existingData = { _meta: {}, shows: {} };
  if (fs.existsSync(OUTPUT_FILE)) {
    existingData = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
  }

  // Filter shows
  let shows = showsData.shows;
  if (showFilter) {
    shows = shows.filter(s => s.slug === showFilter || s.id === showFilter);
    if (shows.length === 0) {
      console.error(`Show not found: ${showFilter}`);
      process.exit(1);
    }
  }

  // Filter to shows with enough data for LLM (>= 5 reviews)
  const eligibleShows = shows.filter(s => (reviewCountMap.get(s.id) || 0) >= 5);
  console.log(`Eligible shows (5+ reviews): ${eligibleShows.length}`);

  // Skip already-processed unless --force
  const today = new Date().toISOString().split('T')[0];
  let showsToProcess = force ? eligibleShows : eligibleShows.filter(s => {
    const existing = existingData.shows[s.id];
    if (!existing) return true;
    // Regenerate if older than 30 days
    const age = (Date.now() - new Date(existing.lastUpdated).getTime()) / (1000 * 60 * 60 * 24);
    return age > 30;
  });

  // Sort: missing shows first (never processed), then stale shows by age (oldest first)
  showsToProcess.sort((a, b) => {
    const aExisting = existingData.shows[a.id];
    const bExisting = existingData.shows[b.id];
    const aMissing = !aExisting;
    const bMissing = !bExisting;
    if (aMissing !== bMissing) return aMissing ? -1 : 1;
    if (aMissing && bMissing) return 0;
    // Both stale — oldest first
    return new Date(aExisting.lastUpdated) - new Date(bExisting.lastUpdated);
  });

  // Apply --max cap (missing shows always processed first due to sort)
  if (maxShows > 0 && showsToProcess.length > maxShows) {
    console.log(`Capping at --max=${maxShows} (${showsToProcess.length} eligible)`);
    showsToProcess = showsToProcess.slice(0, maxShows);
  }

  const missingCount = showsToProcess.filter(s => !existingData.shows[s.id]).length;
  console.log(`To process: ${showsToProcess.length} (${missingCount} new, ${showsToProcess.length - missingCount} stale)`);

  if (showsToProcess.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Build batches of 10
  const BATCH_SIZE = 10;
  const batches = [];
  for (let i = 0; i < showsToProcess.length; i += BATCH_SIZE) {
    batches.push(showsToProcess.slice(i, i + BATCH_SIZE));
  }

  let processed = 0;
  let failed = 0;
  let usedAlgorithmic = 0;

  // Helper: process LLM results for a pool and fill from candidates
  function processPoolResults(result, batchInput, pool) {
    const candKey = pool === 'open' ? 'openCandidates' : 'closedCandidates';
    const resultKey = pool === 'open' ? 'relatedOpenIds' : 'relatedClosedIds';
    const recommendations = result ? result.parsed : null;

    for (const item of batchInput) {
      const show = item.show;
      const candidates = item[candKey];
      let recs = recommendations?.[show.id];

      if (Array.isArray(recs) && recs.length > 0) {
        recs = recs.filter(id => showById.has(id) && id !== show.id);
        recs = deduplicateProductions(recs, show);
        if (recs.length < 6) {
          const recsSet = new Set(recs);
          for (const c of candidates) {
            if (recs.length >= 6) break;
            if (!recsSet.has(c.id)) { recs.push(c.id); recsSet.add(c.id); }
          }
        }
        recs = recs.slice(0, 6);
      } else {
        // Algorithmic fallback
        recs = candidates.slice(0, 6).map(c => c.id);
      }

      if (!existingData.shows[show.id]) {
        existingData.shows[show.id] = { lastUpdated: today };
      }
      existingData.shows[show.id][resultKey] = recs;
      existingData.shows[show.id].lastUpdated = today;
      // Maintain backward-compat relatedIds (mix of open + closed)
      const openIds = existingData.shows[show.id].relatedOpenIds || [];
      const closedIds = existingData.shows[show.id].relatedClosedIds || [];
      existingData.shows[show.id].relatedIds = [...openIds.slice(0, 4), ...closedIds.slice(0, 2)];
    }
  }

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    console.log(`\nBatch ${bi + 1}/${batches.length} (${batch.length} shows):`);

    // Pre-filter candidates for each show — separate open and closed pools
    const batchInput = batch.map(show => {
      const openCandidates = algorithmicCandidates(show, 15, 'open');
      const closedCandidates = algorithmicCandidates(show, 15, 'closed');

      // Get comparison pair IDs for this show
      const comparisonSlugs = comparisonMap.get(show.slug) || [];
      const comparisonIds = comparisonSlugs
        .map(slug => slugToId.get(slug))
        .filter(id => id && id !== show.id);

      // Merge comparison pair shows into appropriate candidate pool
      const openCandIds = new Set(openCandidates.map(c => c.id));
      const closedCandIds = new Set(closedCandidates.map(c => c.id));
      for (const cId of comparisonIds) {
        const cShow = showById.get(cId);
        if (!cShow) continue;
        const isOpen = cShow.status === 'open' || cShow.status === 'previews';
        if (isOpen && !openCandIds.has(cId)) openCandidates.push(cShow);
        if (!isOpen && !closedCandIds.has(cId)) closedCandidates.push(cShow);
      }

      return { show, openCandidates, closedCandidates, comparisonIds };
    });

    // Call LLM for open pool
    const openPrompt = buildBatchPrompt(batchInput, 'open');
    const openResult = await callLLM(openPrompt);
    if (openResult) {
      console.log(`  Open pool: LLM responded (${openResult.provider})`);
    } else {
      console.log('  Open pool: LLM FAILED — using algorithmic fallback');
      failed++;
    }
    processPoolResults(openResult, batchInput, 'open');

    await sleep(500);

    // Call LLM for closed pool
    const closedPrompt = buildBatchPrompt(batchInput, 'closed');
    const closedResult = await callLLM(closedPrompt);
    if (closedResult) {
      console.log(`  Closed pool: LLM responded (${closedResult.provider})`);
    } else {
      console.log('  Closed pool: LLM FAILED — using algorithmic fallback');
      failed++;
    }
    processPoolResults(closedResult, batchInput, 'closed');

    processed += batch.length;

    for (const item of batchInput) {
      if (dryRun) {
        const show = item.show;
        const entry = existingData.shows[show.id];
        console.log(`  ${show.title}:`);
        console.log(`    Open:   ${(entry.relatedOpenIds || []).map(id => showById.get(id)?.title || id).join(', ')}`);
        console.log(`    Closed: ${(entry.relatedClosedIds || []).map(id => showById.get(id)?.title || id).join(', ')}`);
      }
    }

    // Checkpoint every 25 shows
    if (!dryRun && processed > 0 && (processed % 25 < BATCH_SIZE || bi === batches.length - 1)) {
      existingData._meta = {
        lastGenerated: today,
        showCount: Object.keys(existingData.shows).length,
      };
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(existingData, null, 2));
      console.log(`  [Checkpoint] Saved ${Object.keys(existingData.shows).length} shows`);
    }

    // Rate limiting between batches
    if (bi < batches.length - 1) {
      await sleep(1000);
    }
  }

  // Final save
  if (!dryRun) {
    existingData._meta = {
      lastGenerated: today,
      showCount: Object.keys(existingData.shows).length,
    };
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(existingData, null, 2));
  }

  console.log(`\n=== Done ===`);
  console.log(`LLM processed: ${processed}`);
  console.log(`Algorithmic fallback: ${usedAlgorithmic}`);
  console.log(`Failed batches: ${failed}`);
  console.log(`Total in file: ${Object.keys(existingData.shows).length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
