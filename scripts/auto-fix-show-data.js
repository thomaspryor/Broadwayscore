#!/usr/bin/env node
/**
 * auto-fix-show-data.js
 *
 * Automatically fixes show data issues - FULL automation:
 * - Missing images → triggers image fetch workflow
 * - Missing synopsis → fetches from TodayTix or generates via Claude
 * - Missing creative team → fetches from TodayTix or generates via Claude
 * - Missing/broken ticket links → hides them (not an error)
 *
 * Philosophy: Fix EVERYTHING automatically. Zero human intervention needed.
 * Cast is NOT tracked (changes too frequently).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { isValidSynopsis, classifyBadSynopsis } = require('./lib/synopsis-validation');
const { verifyProductionMatch } = require('./lib/synopsis-production-match');
const { isValidCreativeTeamName, lookupIBDBDates } = require('./lib/ibdb-dates');
const { serpQuery } = require('./lib/url-discovery');
const { CLAUDE_HAIKU, CLAUDE_OPUS } = require('./lib/models');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const TODAYTIX_IDS_PATH = path.join(__dirname, '..', 'data', 'todaytix-ids.json');
const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Results tracking
const results = {
  timestamp: new Date().toISOString(),
  fixed: [],
  needsHumanAttention: [],
  triggeredWorkflows: [],
  errors: []
};

function loadShows() {
  return JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
}

function saveShows(data) {
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function loadTodayTixIds() {
  try {
    return JSON.parse(fs.readFileSync(TODAYTIX_IDS_PATH, 'utf8'));
  } catch {
    return { shows: {} };
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Fetch via ScrapingBee
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    if (!SCRAPINGBEE_API_KEY) {
      reject(new Error('No SCRAPINGBEE_API_KEY'));
      return;
    }

    const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_API_KEY}&url=${encodeURIComponent(url)}&render_js=true&wait=2000`;

    https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// isValidSynopsis is imported from ./lib/synopsis-validation
// (extracted so pre-deploy-check.js and tests can share the exact same rules,
// including the LLM-refusal guard that caught the Graham100 incident).

// Extract synopsis from TodayTix page HTML
function extractSynopsisFromHtml(html) {
  // Try to find synopsis in meta description
  const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
  if (metaMatch && metaMatch[1].length > 50) {
    const candidate = metaMatch[1].trim();
    if (isValidSynopsis(candidate)) return candidate;
  }

  // Try to find in JSON-LD
  const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const jsonLd = JSON.parse(jsonLdMatch[1]);
      if (jsonLd.description && jsonLd.description.length > 50) {
        const candidate = jsonLd.description.trim();
        if (isValidSynopsis(candidate)) return candidate;
      }
    } catch {}
  }

  // Try to find in page content (common patterns)
  const aboutMatch = html.match(/about[^>]*>[\s\S]*?<p[^>]*>([^<]{100,500})/i);
  if (aboutMatch) {
    const candidate = aboutMatch[1].trim();
    if (isValidSynopsis(candidate)) return candidate;
  }

  return null;
}

// Extract creative team from TodayTix page HTML
function extractCreativeTeamFromHtml(html) {
  const creativeTeam = [];

  // Try JSON-LD first (most reliable)
  const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const match of jsonLdMatch) {
      try {
        const content = match.match(/>([\s\S]*?)<\/script>/i)[1];
        const jsonLd = JSON.parse(content);

        // Check for director
        if (jsonLd.director) {
          const directors = Array.isArray(jsonLd.director) ? jsonLd.director : [jsonLd.director];
          for (const d of directors) {
            const name = typeof d === 'string' ? d : d.name;
            if (name) creativeTeam.push({ name, role: 'Director' });
          }
        }

        // Check for author/writer
        if (jsonLd.author) {
          const authors = Array.isArray(jsonLd.author) ? jsonLd.author : [jsonLd.author];
          for (const a of authors) {
            const name = typeof a === 'string' ? a : a.name;
            if (name) creativeTeam.push({ name, role: 'Book' });
          }
        }
      } catch {}
    }
  }

  // Loose regex extraction removed (2026-04-14): scanning entire page HTML with
  // patterns like /directed by ([A-Z][a-z]+ [A-Z][a-z]+)/ picked up credits from
  // related-shows sidebars and captured "Tony Award" from "directed by Tony Award
  // winner X". JSON-LD is the only reliable extraction path from TodayTix HTML.
  // See tests/unit/creative-team-validator.test.mjs for the junk-name lock-in.

  // Filter JSON-LD results through the shared validator to catch any residual junk
  const filtered = creativeTeam.filter(c => isValidCreativeTeamName(c.name));
  return filtered.length > 0 ? filtered : null;
}

// Build a TodayTix show URL for the correct location prefix.
// Prefer the stored todaytixUrl (always has the right /london/ or /nyc/ prefix);
// otherwise derive from show.category. Hardcoding /nyc/ caused WE/OWE shows to
// fail JSON-LD fetches and fall back to LLM creative-team generation, which
// hallucinated directors for same-title revivals (e.g. Into the Woods at the
// Bridge Theatre credited to Terry Johnson instead of Jordan Fein on 2026-04-22).
function todayTixUrl(show, todayTixInfo) {
  if (show?.todaytixUrl) return show.todaytixUrl;
  const slug = todayTixInfo.slug || show.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const cat = show?.category || '';
  const prefix = (cat === 'west-end' || cat === 'off-west-end') ? 'london' : 'nyc';
  return `https://www.todaytix.com/${prefix}/shows/${todayTixInfo.id}-${slug}`;
}

// Fetch synopsis from TodayTix
async function fetchSynopsisFromTodayTix(show, todayTixInfo) {
  if (!todayTixInfo?.id) return null;

  const url = todayTixUrl(show, todayTixInfo);

  try {
    const html = await fetchUrl(url);
    return extractSynopsisFromHtml(html);
  } catch {
    return null;
  }
}

// Fetch creative team from TodayTix
async function fetchCreativeTeamFromTodayTix(show, todayTixInfo) {
  if (!todayTixInfo?.id) return null;

  const url = todayTixUrl(show, todayTixInfo);

  try {
    const html = await fetchUrl(url);
    return extractCreativeTeamFromHtml(html);
  } catch {
    return null;
  }
}

// Generate synopsis via Claude API. Haiku first (cheap); on a null/refusal/
// invalid result, escalate to Opus, which knows the long tail (operas, older +
// regional plays). The wrong-show verification gate is applied by the caller
// (fixSynopsis) so it covers BOTH this and the TodayTix scrape path — see the
// note there. Here we only return a well-formed, non-refusal candidate.
async function generateSynopsisWithLLM(show) {
  if (!ANTHROPIC_API_KEY) return null;

  const year = show.openingDate?.slice(0, 4) || '';
  const castInfo = show.cast && show.cast.length > 0
    ? `Cast: ${show.cast.map(c => c.name).join(', ')}.` : '';
  const creativeInfo = show.creativeTeam && show.creativeTeam.length > 0
    ? `Creative team: ${show.creativeTeam.map(c => `${c.name} (${c.role})`).join(', ')}.` : '';
  const prompt = `Write a brief, factual synopsis (2-3 sentences, ~100 words) for this SPECIFIC theatrical production:
Title: "${show.title}"${year ? ` (${year})` : ''}
Type: ${show.type || 'play'}
Venue: ${show.venue || 'a Broadway theater'}
${castInfo}
${creativeInfo}
The cast, year, and venue identify the exact production — titles are often shared by unrelated shows, so use them to pin down WHICH show this is.
If you are not certain about the plot of THIS specific production, reply with exactly: UNKNOWN
Do NOT guess or describe a different same-titled show.
Write in present tense. Focus on the SPECIFIC plot/premise — what is it actually about?
Do NOT open with production history ("X is a play written by Y", "had its world premiere", "transferred to"). Start with the story, setting, or central premise.
No generic descriptions, marketing language, or ticket information.
Return only the synopsis text (or exactly UNKNOWN), nothing else.`;

  const usable = (t) => t && !/^\s*UNKNOWN\s*$/i.test(t.trim()) && isValidSynopsis(t) ? t : null;
  const haiku = usable(await callClaudeAPI(prompt, 200, CLAUDE_HAIKU));
  if (haiku) return haiku;
  return usable(await callClaudeAPI(prompt, 200, CLAUDE_OPUS));
}

// Generate creative team via Claude API (fallback)
// Pass synopsis + opening year + venue as production-specific context so the LLM
// doesn't confuse the requested show with a same-title production by a different
// team (e.g. Seagull: True Story vs Jamie Lloyd's 2025 WE Seagull).
async function generateCreativeTeamWithLLM(show) {
  if (!ANTHROPIC_API_KEY) return null;

  const year = show.openingDate?.slice(0, 4) || 'upcoming';
  const synopsis = (show.synopsis || '').slice(0, 500);
  const venueLine = show.venue ? `\nVenue: ${show.venue}` : '';
  const contextLine = synopsis ? `\nSynopsis: ${synopsis}` : '';

  const prompt = `List the main creative team for this specific theatrical production.

Title: ${show.title}
Type: ${show.type || 'play'}
Year: ${year}${venueLine}${contextLine}

Return ONLY a JSON array with objects containing "name" and "role" fields.
Include: Director, Book writer, Composer, Lyricist, Choreographer (if applicable).
If the synopsis names specific people and roles, you MUST use them.
Only include people you are certain about for THIS production (not same-title revivals).
If uncertain, return an empty array [] rather than guessing.
Example format: [{"name": "Lin-Manuel Miranda", "role": "Music & Lyrics"}, {"name": "Thomas Kail", "role": "Director"}]
Return ONLY the JSON array, no other text.`;

  const response = await callClaudeAPI(prompt, 300);
  if (!response) return null;

  try {
    // Extract JSON from response (in case there's extra text)
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const team = JSON.parse(jsonMatch[0]);
      if (Array.isArray(team) && team.length > 0) {
        return team.filter(t => t.name && t.role);
      }
    }
  } catch {}

  return null;
}

// Helper function to call Claude API
function callClaudeAPI(prompt, maxTokens, model = CLAUDE_HAIKU) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          const text = response.content?.[0]?.text;
          resolve(text || null);
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.write(postData);
    req.end();
  });
}

// Fix synopsis - fetch from TodayTix or generate
async function fixSynopsis(show, todayTixIds) {
  // Regenerate if the synopsis is missing OR bad (refusal / generic
  // production-history placeholder / stale future-tense / invalid). A 50-char
  // length check alone let the 1536 placeholder survive (2026-06-21).
  if (!classifyBadSynopsis(show).bad) {
    return null; // Already has a good synopsis
  }

  console.log(`  📝 Synopsis missing or low-quality, attempting to fetch...`);

  // Wrong-show gate for EVERY candidate before it can be saved. Both sources
  // emit confident wrong-show content that isValidSynopsis can't catch:
  //   - TodayTix recycles numeric IDs, so a stale ID serves a DIFFERENT show
  //     (rabbit-hole-2006's ID → a "Radiolab/Selected Shorts" event, 2026-06-21).
  //   - LLMs write a same-titled show's plot ("All About Me" 2010 → "All of Me"
  //     2024). Verifier (Opus) validated 4/4 on that golden set.
  // No API key → no verifier → DON'T persist anything. TodayTix recycles IDs
  // (serves a different show), so an unverified TodayTix synopsis is exactly the
  // wrong-show risk; "never fake data" beats filling it. Without a key the LLM
  // path is moot anyway (generateSynopsisWithLLM returns null), so this just
  // leaves the field null in keyless local runs. The cron always has the key.
  const verifier = ANTHROPIC_API_KEY ? (p => callClaudeAPI(p, 200, CLAUDE_OPUS)) : null;
  const accept = async (text, source) => {
    if (!text || !isValidSynopsis(text)) return false;
    if (!verifier) {
      console.log(`    ✗ skipped ${source} synopsis — no verifier (ANTHROPIC_API_KEY) to confirm right show`);
      return false;
    }
    const { match, reason } = await verifyProductionMatch(show, text, verifier);
    if (!match) {
      console.log(`    ✗ rejected ${source} synopsis (wrong show): ${reason}`);
      return false;
    }
    show.synopsis = text;
    return true;
  };

  // Try TodayTix first
  const todayTixInfo = todayTixIds.shows[show.id] || todayTixIds.shows[show.slug];
  if (await accept(await fetchSynopsisFromTodayTix(show, todayTixInfo), 'TodayTix')) {
    return `Fetched synopsis from TodayTix for ${show.title}`;
  }

  // Try LLM generation
  if (ANTHROPIC_API_KEY) {
    console.log(`    Generating via Claude...`);
    if (await accept(await generateSynopsisWithLLM(show), 'LLM')) {
      return `Generated synopsis via Claude for ${show.title}`;
    }
  }

  return null;
}

// SERP-verified LLM creative team generation (off-Broadway / West End only)
// Step 1: LLM proposes director (and optionally playwright/composer)
// Step 2: For each proposed member, verify via SERP before accepting
// Only accepts a member if a SERP snippet confirms "directed by [name]" or equivalent.
async function generateCreativeTeamWithSerpVerification(show) {
  const year = show.openingDate?.slice(0, 4) || 'upcoming';
  const synopsis = (show.synopsis || '').slice(0, 500);
  const marketHint = show.ibdbUrl ? '' : (show.slug?.includes('west-end') || show.venue?.toLowerCase().includes('london') ? 'West End' : 'off-Broadway');

  const prompt = `List the main creative team for this specific theatrical production.

Title: ${show.title}
Type: ${show.type || 'play'}
Year: ${year}
Market: ${marketHint || 'off-Broadway'}${show.venue ? `\nVenue: ${show.venue}` : ''}${synopsis ? `\nSynopsis: ${synopsis}` : ''}

Return ONLY a JSON array with objects containing "name" and "role" fields.
Include: Director, and Playwright/Book/Composer/Lyricist if applicable.
Only include people you are certain about for THIS specific production.
If uncertain about any person, omit them rather than guessing.
Return ONLY the JSON array, no other text. Example:
[{"name": "Sam Gold", "role": "Director"}, {"name": "Suzan-Lori Parks", "role": "Playwright"}]`;

  const response = await callClaudeAPI(prompt, 300);
  if (!response) return null;

  let proposed;
  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;
    proposed = JSON.parse(jsonMatch[0]).filter(t => t.name && t.role && isValidCreativeTeamName(t.name));
  } catch {
    return null;
  }

  if (!proposed || proposed.length === 0) return null;

  // Step 2: SERP-verify each proposed member.
  // 2026-05-26: previously non-director roles were accepted without verification.
  // Result: LLM hallucinated "Martyna Majok (Book Writer)" for Liberation (correct:
  // Bess Wohl, Playwright) and reached production. Now ALL roles require SERP
  // confirmation; unrecognized roles are rejected rather than silently accepted.
  // Canonical role label written into show.creativeTeam. src/lib/data-creative.ts
  // ROLE_TO_CATEGORIES is exact-case — writing "playwright" or "Book writer"
  // (lowercase from LLM) silently drops the entry from /playwrights pages.
  const ROLE_CANON = {
    director: 'Director', playwright: 'Playwright', choreographer: 'Choreographer',
    'book writer': 'Book Writer', book: 'Book',
    composer: 'Composer', lyricist: 'Lyricist',
  };
  const verified = [];
  for (const member of proposed) {
    const role = String(member.role || '').toLowerCase();
    const roleVerb = role === 'director' ? 'directed by' :
                     role === 'playwright' ? 'written by' :
                     role === 'choreographer' ? 'choreographed by' :
                     (role === 'book writer' || role === 'book') ? 'book by' :
                     role === 'composer' ? 'music by' :
                     role === 'lyricist' ? 'lyrics by' : null;
    if (!roleVerb) {
      console.log(`    ❌ Unrecognized role "${member.role}" for ${member.name} — rejecting (cannot SERP-verify)`);
      continue;
    }
    const canonRole = ROLE_CANON[role];

    const query = `"${show.title}" ${year} "${roleVerb} ${member.name}"`;
    console.log(`    🔍 Verifying: ${member.name} (${member.role}) via SERP...`);
    try {
      await sleep(500);
      const serpResults = await serpQuery(query);
      if (serpResults && serpResults.length > 0) {
        // Require the full phrase "directed by [name]" in a snippet — not just the name.
        // This prevents false-positives where the name appears in unrelated context.
        const nameLC = member.name.toLowerCase();
        const phraseLC = `${roleVerb} ${nameLC}`;
        const confirmed = serpResults.some(r => {
          const text = ((r.title || '') + ' ' + (r.snippet || '')).toLowerCase();
          return text.includes(phraseLC);
        });
        if (confirmed) {
          console.log(`    ✅ SERP confirmed: ${member.name} (${member.role})`);
          verified.push({ ...member, role: canonRole, _source: 'serp-verified-llm' });
        } else {
          console.log(`    ❌ SERP did not confirm: ${member.name} (${member.role}) — rejecting`);
        }
      } else {
        console.log(`    ❌ No SERP results for ${member.name} (${member.role}) — rejecting`);
      }
    } catch (e) {
      console.log(`    ⚠️  SERP verification failed for ${member.name}: ${e.message}`);
    }
  }

  return verified.length > 0 ? verified : null;
}

// Fix creative team - fetch from TodayTix, IBDB (Broadway), or SERP-verified LLM (OB/WE)
async function fixCreativeTeam(show, todayTixIds) {
  if (show.creativeTeam && show.creativeTeam.length >= 2) {
    return null; // Already has creative team
  }

  console.log(`  🎬 Missing creative team, attempting to fetch...`);

  // Step 1: TodayTix JSON-LD
  const todayTixInfo = todayTixIds.shows[show.id] || todayTixIds.shows[show.slug];
  let creativeTeam = await fetchCreativeTeamFromTodayTix(show, todayTixInfo);

  if (creativeTeam && creativeTeam.length >= 2) {
    creativeTeam = creativeTeam.filter(m => isValidCreativeTeamName(m.name));
    if (creativeTeam.length >= 2) {
      show.creativeTeam = creativeTeam;
      return `Fetched creative team from TodayTix for ${show.title} (${creativeTeam.length} members)`;
    }
  }

  // Step 2: IBDB (Broadway shows only — IBDB is Broadway-authoritative)
  // ibdbUrl is pre-stored on Broadway shows by discover-new-shows.js
  // Note: lookupIBDBDates runs a production-year gate. If show.openingDate is
  // missing, the gate trips and creativeTeam comes back empty. That's by
  // design — same-title revivals can collide without a year anchor.
  if (show.ibdbUrl && SCRAPINGBEE_API_KEY) {
    console.log(`    Fetching from IBDB...`);
    try {
      const openingYear = show.openingDate ? parseInt(show.openingDate.slice(0, 4)) : undefined;
      const ibdb = await lookupIBDBDates(show.title, { ibdbUrl: show.ibdbUrl, openingYear });
      if (ibdb.creativeTeam && ibdb.creativeTeam.length >= 1) {
        // Defensive: never overwrite an existing non-empty creativeTeam from IBDB
        // without a louder signal. The guard at line 413 already returns early if
        // show.creativeTeam.length >= 2, so we only reach here when it's empty
        // or has 1 entry — log the latter so regressions are auditable.
        if (show.creativeTeam && show.creativeTeam.length > 0) {
          console.log(`    ⚠️  IBDB replacing existing creativeTeam[${show.creativeTeam.length}] on ${show.id}`);
        }
        show.creativeTeam = ibdb.creativeTeam;
        return `Fetched creative team from IBDB for ${show.title} (${ibdb.creativeTeam.length} members)`;
      }
    } catch (e) {
      console.log(`    ⚠️  IBDB fetch failed: ${e.message}`);
    }
  }

  // Step 3: SERP-verified LLM (off-Broadway and West End — no IBDB coverage)
  // Only runs when show has no ibdbUrl (OB/WE) and both API keys are available.
  // Two-step: LLM proposes a director, SERP verifies it exists before accepting.
  // This prevents the hallucination pattern (film directors, original-production
  // directors, actors assigned to shows they're not connected to).
  if (!show.ibdbUrl && ANTHROPIC_API_KEY && SCRAPINGBEE_API_KEY) {
    console.log(`    Generating via SERP-verified LLM...`);
    creativeTeam = await generateCreativeTeamWithSerpVerification(show);
    if (creativeTeam && creativeTeam.length >= 1) {
      show.creativeTeam = creativeTeam;
      return `Generated creative team (SERP-verified) for ${show.title} (${creativeTeam.length} members)`;
    }
  }

  console.log(`    ⚠️  No creative team source available — leaving blank.`);
  return null;
}

// Returns false only if synopsis explicitly names a director AND the team's
// director contradicts it. No synopsis mention → pass (can't verify). No team
// director → pass (nothing to contradict).
function creativeTeamMatchesSynopsis(team, synopsis) {
  if (!synopsis) return true;
  const m = synopsis.match(/directed\s+by\s+([A-Z][a-zA-Z'’\-]+(?:\s+[A-Z][a-zA-Z'’\-]+){1,3})/);
  if (!m) return true;
  const synopsisDir = m[1].toLowerCase();
  const teamDirs = team.filter(c => /(^|\s|&\s*)Director(\s|$|&)/i.test(c.role || ''));
  if (!teamDirs.length) return true;
  return teamDirs.some(d => {
    const n = d.name.toLowerCase();
    const lastSyn = synopsisDir.split(/\s+/).pop();
    const lastTeam = n.split(/\s+/).pop();
    return n.includes(synopsisDir) || synopsisDir.includes(n) || (lastSyn && lastSyn === lastTeam);
  });
}

// Fix ticket links - just ensure valid ones exist, hide broken ones
function fixTicketLinks(show) {
  if (show.status === 'closed') return null;

  // Remove any links marked as broken
  if (show.ticketLinks) {
    const validLinks = show.ticketLinks.filter(link => !link.broken && link.url);
    if (validLinks.length !== show.ticketLinks.length) {
      show.ticketLinks = validLinks;
      return `Removed ${show.ticketLinks.length - validLinks.length} broken ticket links for ${show.title}`;
    }
  }

  // If no ticket links at all for an open show, that's OK - we just won't show any
  // Don't flag it as an error - the show page will gracefully hide the ticket section

  return null;
}

function checkMissingImages(show) {
  const missing = [];
  if (!show.images?.poster) missing.push('poster');
  if (!show.images?.thumbnail) missing.push('thumbnail');
  if (!show.images?.hero) missing.push('hero');
  return missing;
}

async function main() {
  const args = process.argv.slice(2);
  const backfillHistorical = args.includes('--backfill-historical');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;
  const showArg = args.find(a => a.startsWith('--show='));
  const showIds = showArg ? new Set(showArg.split('=')[1].split(',').map(s => s.trim())) : null;

  console.log('='.repeat(60));
  console.log('AUTO-FIX SHOW DATA');
  if (backfillHistorical) console.log('MODE: Backfill historical shows (synopsis + creative team)');
  console.log('='.repeat(60));
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Synopsis fetching: ${SCRAPINGBEE_API_KEY ? '✓ enabled' : '✗ disabled (no SCRAPINGBEE_API_KEY)'}`);
  console.log(`Synopsis generation: ${ANTHROPIC_API_KEY ? '✓ enabled' : '✗ disabled (no ANTHROPIC_API_KEY)'}\n`);

  const data = loadShows();
  const todayTixIds = loadTodayTixIds();

  // Select which shows to process
  let targetShows;
  if (showIds) {
    // Targeted backfill of specific show IDs (e.g. re-fixing known placeholders)
    targetShows = data.shows.filter(s => showIds.has(s.id));
    console.log(`Targeting ${targetShows.length} show(s) by id...\n`);
  } else if (backfillHistorical) {
    // All shows with a missing OR bad synopsis, regardless of status
    targetShows = data.shows.filter(s => classifyBadSynopsis(s).bad);
    if (limit > 0) {
      targetShows = targetShows.slice(0, limit);
    }
    console.log(`Found ${targetShows.length} shows with missing/bad synopsis${limit > 0 ? ` (limited to ${limit})` : ''}...\n`);
  } else {
    targetShows = data.shows.filter(s => s.status === 'open' || s.status === 'previews');
    console.log(`Checking ${targetShows.length} open/preview shows...\n`);
  }

  let showsWithMissingImages = [];
  let changesMade = false;
  let checkpointCount = 0;

  for (let i = 0; i < targetShows.length; i++) {
    const show = targetShows[i];
    if (backfillHistorical) {
      console.log(`[${i + 1}/${targetShows.length}] ${show.title} (${show.id})`);
    } else {
      console.log(`Checking: ${show.title}`);
    }

    // 1. Fix synopsis
    const synopsisFix = await fixSynopsis(show, todayTixIds);
    if (synopsisFix) {
      results.fixed.push(synopsisFix);
      console.log(`    ✓ ${synopsisFix}`);
      changesMade = true;
      await sleep(1000); // Rate limit
    }

    // 2. Fix creative team (auto-fetched or LLM-generated)
    const creativeFix = await fixCreativeTeam(show, todayTixIds);
    if (creativeFix) {
      results.fixed.push(creativeFix);
      console.log(`    ✓ ${creativeFix}`);
      changesMade = true;
      await sleep(1000); // Rate limit
    }

    // 3. Fix ticket links (skip for historical/targeted backfill — focus on synopsis)
    if (!backfillHistorical && !showIds) {
      const ticketFix = fixTicketLinks(show);
      if (ticketFix) {
        results.fixed.push(ticketFix);
        console.log(`    ✓ ${ticketFix}`);
        changesMade = true;
      }
    }

    // 4. Check for missing images (skip during historical backfill — handled by image workflow)
    if (!backfillHistorical) {
      const missingImages = checkMissingImages(show);
      if (missingImages.length > 0) {
        showsWithMissingImages.push({
          id: show.id,
          title: show.title,
          missing: missingImages
        });
        console.log(`    ⚠ Missing images: ${missingImages.join(', ')}`);
      }
    }

    // Checkpoint every 50 shows during historical backfill (saves progress on timeout)
    if (backfillHistorical && changesMade && (i + 1) % 50 === 0) {
      saveShows(data);
      checkpointCount++;
      console.log(`\n--- Checkpoint ${checkpointCount}: saved ${results.fixed.length} fixes ---\n`);
    }
  }

  // Save updated shows data
  if (changesMade) {
    saveShows(data);
    console.log(`\n✅ Saved changes to shows.json`);
  }

  // Flag shows needing images (not during historical backfill)
  if (!backfillHistorical && showsWithMissingImages.length > 0) {
    results.triggeredWorkflows.push('fetch-show-images-auto');
    console.log(`\n🖼️  ${showsWithMissingImages.length} shows need images - will trigger fetch workflow`);

    fs.writeFileSync(
      path.join(__dirname, '..', 'data', 'shows-needing-images.json'),
      JSON.stringify(showsWithMissingImages, null, 2)
    );
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Auto-fixed: ${results.fixed.length} issues`);
  if (!backfillHistorical) {
    console.log(`Needs images: ${showsWithMissingImages.length} shows`);
    console.log(`Workflows to trigger: ${results.triggeredWorkflows.join(', ') || 'none'}`);
  }

  // Write results
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'auto-fix-results.json'),
    JSON.stringify(results, null, 2)
  );

  // GitHub Actions outputs
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `fixed_count=${results.fixed.length}\n`);
    fs.appendFileSync(outputFile, `needs_images=${showsWithMissingImages.length > 0}\n`);
    fs.appendFileSync(outputFile, `needs_human=0\n`);
    fs.appendFileSync(outputFile, `shows_needing_attention=\n`);
  }

  return results;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
