#!/usr/bin/env node
/**
 * audit-images-llm.js
 *
 * Uses Gemini 2.0 Flash vision to verify that every show's thumbnail
 * actually depicts the correct Broadway show.
 *
 * Usage:
 *   node scripts/audit-images-llm.js                  # Dry-run (default) - audit only
 *   node scripts/audit-images-llm.js --apply           # Delete bad images + update shows.json
 *   node scripts/audit-images-llm.js --validate-only   # Run prompt validation with known samples only
 *   node scripts/audit-images-llm.js --show=hamilton-2015  # Audit single show
 *
 * Outputs: data/audit/image-verification.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ============================================================
// CONFIG
// ============================================================

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const AUDIT_DIR = path.join(__dirname, '..', 'data', 'audit');
const AUDIT_OUTPUT = path.join(AUDIT_DIR, 'image-verification.json');
const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images', 'shows');
const DELETED_DIR = path.join(AUDIT_DIR, 'deleted-images');

const RPM_LIMIT = 10;          // Requests per minute (conservative for free tier)
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;    // Exponential backoff base

// ============================================================
// GEMINI VISION PROMPT
// ============================================================

const VERIFICATION_PROMPT = `You are verifying Broadway show thumbnail images. I will show you an image that is supposed to be the thumbnail for a specific Broadway show.

Your task: Determine if this image is a legitimate promotional image, poster artwork, logo, or production photo for the named show.

IMPORTANT RULES:
- Many Broadway shows use simple text-based logos or stylized title treatments as their official promotional art. These ARE correct if they show the right show title.
- Playbill-standard template images (yellow PLAYBILL header with a show photo below) are NOT acceptable thumbnails - they are photos of physical playbill programs, not promotional art.
- Seating charts, venue maps, ticket listings, social media logos, and generic graphics are NOT acceptable.
- If the image shows a DIFFERENT Broadway show's title or artwork, it is wrong.
- A generic theater/stage photo without any show-specific branding is NOT acceptable.
- Revival productions may share artwork with earlier productions - this is acceptable.

Reply with ONLY this JSON (no markdown fencing, no explanation):
{"match":true,"confidence":"high","description":"brief description of what the image shows","issues":[]}

Or if there's a problem:
{"match":false,"confidence":"high","description":"brief description of what the image actually shows","issues":["category"]}

Issue categories: wrong_show, playbill_cover, seating_chart, logo_not_show, generic_image, social_media_logo, ticket_listing, venue_photo, wrong_production

Confidence levels:
- "high": You are very sure of your assessment
- "medium": You think you're right but aren't certain
- "low": You're guessing`;

// ============================================================
// KNOWN SAMPLES FOR PROMPT VALIDATION (Step 1A)
// ============================================================

// These are shows whose thumbnails we KNOW are correct or wrong,
// used to validate the LLM prompt before running the full audit.
// Categories:
// - known_good: Correct promotional images we've verified
// - known_bad: Images confirmed as wrong/inappropriate
// - edge_case: Legitimate but tricky (text-only logos, revival art)

const KNOWN_SAMPLES = {
  known_good: [
    // Well-known shows with distinctive artwork
    'hamilton-2015',
    'wicked-2003',
    'the-lion-king-1997',
    'dear-evan-hansen-2016',
    'hadestown-2019',
    'beetlejuice-2019',
    'six-2021',
    'moulin-rouge-2019',
    'book-of-mormon-2011',
    'come-from-away-2017',
  ],
  known_bad: [
    // Bob Fosse's Dancin' = X/Twitter logo (cross-contaminated)
    'bob-fosses-dancin-2023',
    // jerusalem-2011 and ohio-state-murders-2022 share same X logo hash
    'jerusalem-2011',
    'ohio-state-murders-2022',
  ],
  edge_case: [
    // Same-show revivals sharing art (should be fine)
    'death-of-a-salesman-2012',
    'death-of-a-salesman-2022',
    // Different shows sharing hash = cross-contaminated
    'arcadia-2011',
    'catch-me-if-you-can-2011',
    'the-country-house-2014',
    'the-royal-family-2009',
  ],
};

// ============================================================
// RATE LIMITER
// ============================================================

class RateLimiter {
  constructor(rpm) {
    this.rpm = rpm;
    this.timestamps = [];
  }

  async wait() {
    const now = Date.now();
    // Remove timestamps older than 60 seconds
    this.timestamps = this.timestamps.filter(t => now - t < 60000);

    if (this.timestamps.length >= this.rpm) {
      const oldest = this.timestamps[0];
      const waitMs = 60000 - (now - oldest) + 100; // +100ms buffer
      if (waitMs > 0) {
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
    this.timestamps.push(Date.now());
  }
}

// ============================================================
// GEMINI VISION CLIENT
// ============================================================

class ImageVerifier {
  constructor(apiKey) {
    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 300,
      }
    });
    this.rateLimiter = new RateLimiter(RPM_LIMIT);
    this.totalCalls = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
  }

  async verifyImage(showTitle, imageData, mimeType) {
    await this.rateLimiter.wait();

    const userPrompt = `The Broadway show is: "${showTitle}"\n\nIs this image a correct thumbnail for this show?`;

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await this.model.generateContent([
          { text: VERIFICATION_PROMPT + '\n\n' + userPrompt },
          {
            inlineData: {
              data: imageData.toString('base64'),
              mimeType: mimeType,
            }
          }
        ]);

        const response = result.response;
        const usage = response.usageMetadata;
        this.totalInputTokens += usage?.promptTokenCount || 0;
        this.totalOutputTokens += usage?.candidatesTokenCount || 0;
        this.totalCalls++;

        const text = response.text().trim();
        return this.parseResponse(text);
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES) {
          const backoff = RETRY_BASE_MS * Math.pow(2, attempt - 1) + Math.random() * 1000;
          console.log(`    Retry ${attempt}/${MAX_RETRIES} after ${Math.round(backoff)}ms: ${err.message}`);
          await new Promise(r => setTimeout(r, backoff));
        }
      }
    }

    return {
      match: null,
      confidence: 'error',
      description: `API error after ${MAX_RETRIES} retries: ${lastError?.message}`,
      issues: ['api_error'],
    };
  }

  async verifyImageFromUrl(showTitle, imageUrl) {
    // Download the image first, then send as base64
    // Gemini doesn't support arbitrary fileUri URLs
    try {
      const resp = await fetch(imageUrl);
      if (resp.ok) {
        const buffer = Buffer.from(await resp.arrayBuffer());
        const contentType = resp.headers.get('content-type') || 'image/jpeg';
        return await this.verifyImage(showTitle, buffer, contentType);
      } else {
        return {
          match: null,
          confidence: 'error',
          description: `Failed to download CDN image: HTTP ${resp.status}`,
          issues: ['download_error'],
        };
      }
    } catch (err) {
      return {
        match: null,
        confidence: 'error',
        description: `Failed to download CDN image: ${err.message}`,
        issues: ['download_error'],
      };
    }
  }

  parseResponse(text) {
    // Strip markdown fencing if present
    let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    try {
      const parsed = JSON.parse(cleaned);
      return {
        match: Boolean(parsed.match),
        confidence: parsed.confidence || 'low',
        description: parsed.description || '',
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      };
    } catch {
      // Try to extract key fields from malformed JSON
      const matchResult = /\"match\"\s*:\s*(true|false)/i.exec(cleaned);
      const confResult = /\"confidence\"\s*:\s*\"(high|medium|low)\"/i.exec(cleaned);
      const descResult = /\"description\"\s*:\s*\"([^\"]*)\"/i.exec(cleaned);

      if (matchResult) {
        return {
          match: matchResult[1] === 'true',
          confidence: confResult?.[1] || 'low',
          description: descResult?.[1] || 'Could not fully parse response',
          issues: [],
        };
      }

      return {
        match: null,
        confidence: 'error',
        description: `Unparseable response: ${cleaned.substring(0, 200)}`,
        issues: ['parse_error'],
      };
    }
  }

  getStats() {
    return {
      totalCalls: this.totalCalls,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      estimatedCost: (this.totalInputTokens * 0.1 + this.totalOutputTokens * 0.4) / 1_000_000,
    };
  }
}

// ============================================================
// IMAGE HASHING
// ============================================================

function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(content).digest('hex');
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
  }[ext] || 'image/jpeg';
}

// ============================================================
// FIND THUMBNAIL FILE
// ============================================================

function findThumbnailFile(showId) {
  const showDir = path.join(IMAGES_DIR, showId);
  if (!fs.existsSync(showDir)) return null;

  // Check for thumbnail files in order of preference
  for (const ext of ['.webp', '.jpg', '.jpeg', '.png']) {
    const filePath = path.join(showDir, `thumbnail${ext}`);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

// ============================================================
// PROMPT VALIDATION (Step 1A)
// ============================================================

async function validatePrompt(verifier, shows) {
  console.log('\n=== PROMPT VALIDATION ===');
  console.log('Testing with known-good, known-bad, and edge-case images...\n');

  const showMap = {};
  shows.forEach(s => { showMap[s.id] = s; });

  const results = { correct: 0, incorrect: 0, errors: 0, total: 0, details: [] };

  async function testShow(showId, expectedCorrect, category) {
    const show = showMap[showId];
    if (!show) {
      console.log(`  SKIP ${showId} - not found in shows.json`);
      return;
    }

    const thumbFile = findThumbnailFile(showId);
    if (!thumbFile) {
      console.log(`  SKIP ${showId} - no thumbnail file`);
      return;
    }

    const imageData = fs.readFileSync(thumbFile);
    const mimeType = getMimeType(thumbFile);
    const result = await verifier.verifyImage(show.title, imageData, mimeType);

    results.total++;
    const correct = (result.match === expectedCorrect);
    if (result.match === null) {
      results.errors++;
      console.log(`  ERROR ${showId}: ${result.description}`);
    } else if (correct) {
      results.correct++;
      console.log(`  PASS  ${showId} (${category}): match=${result.match}, conf=${result.confidence} - ${result.description}`);
    } else {
      results.incorrect++;
      console.log(`  FAIL  ${showId} (${category}): expected match=${expectedCorrect}, got match=${result.match}, conf=${result.confidence} - ${result.description}`);
    }

    results.details.push({
      showId, category, expectedCorrect,
      actualMatch: result.match,
      confidence: result.confidence,
      correct,
      description: result.description,
    });
  }

  // Test known-good images (should be match=true)
  console.log('Known-good images (expecting match=true):');
  for (const id of KNOWN_SAMPLES.known_good) {
    await testShow(id, true, 'known_good');
  }

  // Test known-bad images (should be match=false)
  console.log('\nKnown-bad images (expecting match=false):');
  for (const id of KNOWN_SAMPLES.known_bad) {
    await testShow(id, false, 'known_bad');
  }

  // Edge cases - just report, don't score
  console.log('\nEdge cases (informational):');
  for (const id of KNOWN_SAMPLES.edge_case) {
    const show = showMap[id];
    if (!show) continue;
    const thumbFile = findThumbnailFile(id);
    if (!thumbFile) continue;

    const imageData = fs.readFileSync(thumbFile);
    const mimeType = getMimeType(thumbFile);
    const result = await verifier.verifyImage(show.title, imageData, mimeType);
    console.log(`  INFO  ${id}: match=${result.match}, conf=${result.confidence} - ${result.description}`);
    results.details.push({
      showId: id, category: 'edge_case',
      actualMatch: result.match,
      confidence: result.confidence,
      description: result.description,
    });
  }

  const accuracy = results.total > 0 ? (results.correct / (results.total - results.errors) * 100).toFixed(1) : 0;
  console.log(`\n--- Validation Results ---`);
  console.log(`Correct: ${results.correct}/${results.total - results.errors} (${accuracy}%)`);
  console.log(`Errors: ${results.errors}`);

  if (results.incorrect > 0) {
    console.log(`\nWARNING: ${results.incorrect} incorrect classifications.`);
    console.log('Review the FAIL cases above and adjust the prompt if needed.');
  }

  const falsePositiveRate = results.total > 0 ? (results.incorrect / (results.total - results.errors) * 100).toFixed(1) : 0;
  console.log(`False positive/negative rate: ${falsePositiveRate}%`);

  return { ...results, accuracy: parseFloat(accuracy), falseRate: parseFloat(falsePositiveRate) };
}

// ============================================================
// FULL AUDIT
// ============================================================

async function runFullAudit(verifier, shows, singleShow = null) {
  console.log('\n=== FULL IMAGE AUDIT ===\n');

  // Build hash map for duplicate detection
  console.log('Hashing all thumbnail files...');
  const hashMap = {};  // hash -> [{ showId, filePath }]
  const showMap = {};
  shows.forEach(s => { showMap[s.id] = s; });

  let hashCount = 0;
  for (const show of shows) {
    if (singleShow && show.id !== singleShow) continue;

    const thumbFile = findThumbnailFile(show.id);
    if (thumbFile) {
      const hash = hashFile(thumbFile);
      if (!hashMap[hash]) hashMap[hash] = [];
      hashMap[hash].push({ showId: show.id, filePath: thumbFile });
      hashCount++;
    }
  }
  console.log(`Hashed ${hashCount} thumbnails. Found ${Object.values(hashMap).filter(g => g.length > 1).length} duplicate groups.\n`);

  // Identify same-show revivals vs cross-contamination
  const duplicateGroups = {};
  for (const [hash, entries] of Object.entries(hashMap)) {
    if (entries.length < 2) continue;

    // Extract base show names (strip year suffix)
    const baseNames = entries.map(e => {
      const parts = e.showId.split('-');
      const year = parts[parts.length - 1];
      return /^\d{4}$/.test(year) ? parts.slice(0, -1).join('-') : e.showId;
    });

    const uniqueBaseNames = [...new Set(baseNames)];
    const isSameShow = uniqueBaseNames.length === 1;

    duplicateGroups[hash] = {
      entries,
      baseNames: uniqueBaseNames,
      isSameShow,
      type: isSameShow ? 'revival' : 'cross_contaminated',
    };
  }

  const crossContaminated = Object.entries(duplicateGroups)
    .filter(([, g]) => g.type === 'cross_contaminated');

  console.log(`Same-show revivals (OK): ${Object.values(duplicateGroups).filter(g => g.type === 'revival').length} groups`);
  console.log(`Cross-contaminated (BAD): ${crossContaminated.length} groups\n`);

  // Process each show
  const results = {};
  const showsToAudit = singleShow
    ? shows.filter(s => s.id === singleShow)
    : shows;

  let processed = 0;
  let skipped = 0;
  const total = showsToAudit.length;

  for (const show of showsToAudit) {
    processed++;
    const thumb = show.images?.thumbnail;

    // Determine image source
    let imageSource = null;  // 'local', 'cdn', or null
    let thumbFile = null;
    let imageData = null;
    let mimeType = null;

    if (thumb && thumb.startsWith('http')) {
      imageSource = 'cdn';
    } else if (thumb) {
      thumbFile = findThumbnailFile(show.id);
      if (thumbFile) {
        imageSource = 'local';
        imageData = fs.readFileSync(thumbFile);
        mimeType = getMimeType(thumbFile);
      }
    }

    if (!imageSource) {
      results[show.id] = {
        showId: show.id,
        title: show.title,
        imageSource: null,
        thumbnailPath: thumb || null,
        action: 'skip',
        reason: 'no_thumbnail',
      };
      skipped++;
      continue;
    }

    // Check if part of a cross-contaminated group
    let crossContamGroup = null;
    if (thumbFile) {
      const hash = hashFile(thumbFile);
      if (duplicateGroups[hash] && duplicateGroups[hash].type === 'cross_contaminated') {
        crossContamGroup = {
          hash,
          sharedWith: duplicateGroups[hash].entries
            .filter(e => e.showId !== show.id)
            .map(e => e.showId),
        };
      }
    }

    // Call LLM
    const progress = `[${processed}/${total}]`;
    process.stdout.write(`${progress} ${show.title} (${show.id})... `);

    let verification;
    if (imageSource === 'cdn') {
      verification = await verifier.verifyImageFromUrl(show.title, thumb);
    } else {
      verification = await verifier.verifyImage(show.title, imageData, mimeType);
    }

    // Determine action
    let action = 'keep';
    let reason = '';

    if (verification.match === null) {
      action = 'needs_review';
      reason = 'api_error';
    } else if (verification.match === false && verification.confidence === 'high') {
      action = 'delete';
      reason = verification.issues.join(', ') || 'wrong_image';
    } else if (verification.match === false && verification.confidence === 'medium') {
      action = 'needs_review';
      reason = verification.issues.join(', ') || 'possibly_wrong';
    } else if (verification.match === false) {
      action = 'needs_review';
      reason = 'low_confidence_mismatch';
    }

    // Cross-contaminated images get special handling
    if (crossContamGroup && verification.match === false) {
      action = 'delete';
      reason = `cross_contaminated: shared with ${crossContamGroup.sharedWith.join(', ')}`;
    } else if (crossContamGroup && verification.match === true) {
      // Image matches THIS show - it's the owner. The other shows in the group
      // will be flagged when they're processed.
      reason = `owner (shared hash with ${crossContamGroup.sharedWith.join(', ')})`;
    }

    const statusIcon = action === 'keep' ? 'OK' : action === 'delete' ? 'DELETE' : 'REVIEW';
    console.log(`${statusIcon} - ${verification.description}`);

    results[show.id] = {
      showId: show.id,
      title: show.title,
      imageSource,
      thumbnailPath: thumb,
      localFile: thumbFile || null,
      match: verification.match,
      confidence: verification.confidence,
      description: verification.description,
      issues: verification.issues,
      action,
      reason,
      crossContamGroup: crossContamGroup || null,
    };
  }

  return results;
}

// ============================================================
// APPLY CHANGES
// ============================================================

function applyChanges(results, shows) {
  console.log('\n=== APPLYING CHANGES ===\n');

  // Ensure backup directory exists
  if (!fs.existsSync(DELETED_DIR)) {
    fs.mkdirSync(DELETED_DIR, { recursive: true });
  }

  const deletions = Object.values(results).filter(r => r.action === 'delete');
  const reviews = Object.values(results).filter(r => r.action === 'needs_review');

  console.log(`Will delete: ${deletions.length} images`);
  console.log(`Needs review: ${reviews.length} images`);
  console.log(`Keeping: ${Object.values(results).filter(r => r.action === 'keep').length} images\n`);

  if (deletions.length === 0) {
    console.log('Nothing to delete.');
    return;
  }

  // Archive and delete
  let deleted = 0;
  for (const result of deletions) {
    if (result.localFile && fs.existsSync(result.localFile)) {
      // Archive: copy to deleted-images/{showId}/thumbnail.ext
      const archiveDir = path.join(DELETED_DIR, result.showId);
      if (!fs.existsSync(archiveDir)) {
        fs.mkdirSync(archiveDir, { recursive: true });
      }
      const archivePath = path.join(archiveDir, path.basename(result.localFile));
      fs.copyFileSync(result.localFile, archivePath);

      // Delete original
      fs.unlinkSync(result.localFile);
      deleted++;
      console.log(`  Archived + deleted: ${result.localFile}`);
    }
  }

  // Update shows.json
  const showMap = {};
  shows.forEach(s => { showMap[s.id] = s; });

  let updated = 0;
  for (const result of deletions) {
    const show = showMap[result.showId];
    if (!show) continue;

    if (result.imageSource === 'local' || result.imageSource === 'cdn') {
      show.images.thumbnail = null;
      updated++;
    }
  }

  // Write updated shows.json
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const showsArr = showsData.shows || showsData;
  const isObject = !Array.isArray(showsArr);

  if (isObject) {
    for (const result of deletions) {
      if (showsArr[result.showId]) {
        showsArr[result.showId].images.thumbnail = null;
      }
    }
  } else {
    for (const result of deletions) {
      const show = showsArr.find(s => s.id === result.showId);
      if (show) {
        show.images.thumbnail = null;
      }
    }
  }

  fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2) + '\n');

  console.log(`\nDeleted: ${deleted} image files (archived in ${DELETED_DIR})`);
  console.log(`Updated: ${updated} entries in shows.json (set thumbnail to null)`);
}

// ============================================================
// SUMMARY
// ============================================================

function printSummary(results, verifier) {
  const all = Object.values(results);
  const keep = all.filter(r => r.action === 'keep');
  const del = all.filter(r => r.action === 'delete');
  const review = all.filter(r => r.action === 'needs_review');
  const skip = all.filter(r => r.action === 'skip');

  console.log('\n============================================================');
  console.log('                    AUDIT SUMMARY');
  console.log('============================================================');
  console.log(`Total shows:      ${all.length}`);
  console.log(`  Keep:           ${keep.length}`);
  console.log(`  Delete:         ${del.length}`);
  console.log(`  Needs review:   ${review.length}`);
  console.log(`  Skipped (null): ${skip.length}`);
  console.log('');

  if (del.length > 0) {
    console.log('--- IMAGES TO DELETE ---');
    for (const r of del) {
      console.log(`  ${r.showId}: ${r.description} [${r.reason}]`);
    }
    console.log('');
  }

  if (review.length > 0) {
    console.log('--- IMAGES NEEDING REVIEW ---');
    for (const r of review) {
      console.log(`  ${r.showId}: ${r.description} [${r.reason}]`);
    }
    console.log('');
  }

  const stats = verifier.getStats();
  console.log('--- API USAGE ---');
  console.log(`  API calls:      ${stats.totalCalls}`);
  console.log(`  Input tokens:   ${stats.totalInputTokens}`);
  console.log(`  Output tokens:  ${stats.totalOutputTokens}`);
  console.log(`  Est. cost:      $${stats.estimatedCost.toFixed(4)}`);
  console.log('============================================================\n');
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const applyMode = args.includes('--apply');
  const validateOnly = args.includes('--validate-only');
  const showArg = args.find(a => a.startsWith('--show='));
  const singleShow = showArg ? showArg.split('=')[1] : null;
  const skipValidation = args.includes('--skip-validation');

  // Load API key
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Try loading from .env
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const match = envContent.match(/GEMINI_API_KEY=(.+)/);
      if (match) {
        process.env.GEMINI_API_KEY = match[1].trim();
      }
    }
    if (!process.env.GEMINI_API_KEY) {
      console.error('ERROR: GEMINI_API_KEY not found in environment or .env file');
      process.exit(1);
    }
  }

  const geminiKey = process.env.GEMINI_API_KEY;

  // Load shows
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows || showsData;
  const showsArr = Array.isArray(shows) ? shows : Object.values(shows);

  console.log(`Loaded ${showsArr.length} shows`);
  console.log(`Mode: ${applyMode ? 'APPLY (will delete + update)' : validateOnly ? 'VALIDATE ONLY' : 'DRY RUN (audit only)'}`);
  if (singleShow) console.log(`Single show: ${singleShow}`);

  // Create verifier
  const verifier = new ImageVerifier(geminiKey);

  // Step 1A: Prompt validation
  if (!skipValidation && !singleShow) {
    const validation = await validatePrompt(verifier, showsArr);

    if (validateOnly) {
      console.log('\nPrompt validation complete. Exiting (--validate-only mode).');
      return;
    }

    if (validation.falseRate > 15) {
      console.log('\nWARNING: False positive/negative rate > 15%. Prompt may need tuning.');
      console.log('Run with --validate-only to iterate, or --skip-validation to proceed anyway.');
      if (!applyMode) {
        console.log('Proceeding with dry-run audit despite high error rate...');
      } else {
        console.log('Aborting --apply mode. Fix prompt or use --skip-validation.');
        process.exit(1);
      }
    }
  }

  // Full audit
  const results = await runFullAudit(verifier, showsArr, singleShow);

  // Ensure audit directory exists
  if (!fs.existsSync(AUDIT_DIR)) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
  }

  // Save results
  const auditReport = {
    generatedAt: new Date().toISOString(),
    mode: applyMode ? 'apply' : 'dry-run',
    totalShows: showsArr.length,
    results,
    stats: verifier.getStats(),
  };
  fs.writeFileSync(AUDIT_OUTPUT, JSON.stringify(auditReport, null, 2) + '\n');
  console.log(`\nAudit report saved to ${AUDIT_OUTPUT}`);

  // Print summary
  printSummary(results, verifier);

  // Apply if requested
  if (applyMode) {
    applyChanges(results, showsArr);
  } else {
    const delCount = Object.values(results).filter(r => r.action === 'delete').length;
    if (delCount > 0) {
      console.log(`To apply these changes, run: node scripts/audit-images-llm.js --apply`);
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
