#!/usr/bin/env node
/**
 * verify-image.js
 *
 * Shared Gemini 2.0 Flash vision verification module.
 * Verifies that a Broadway show image matches the correct production.
 *
 * Key improvement over audit-images-llm.js: production-year-aware prompt
 * that catches wrong-production errors (BAM Hamlet vs Broadway Hamlet,
 * Cats 1982 vs Jellicle Ball 2024, etc.)
 *
 * Usage:
 *   const { verifyImage, createRateLimiter } = require('./lib/verify-image');
 *   const result = await verifyImage(imageBuffer, 'Hamlet', { year: '2009' });
 *   // result: { match: true|false, confidence: 'high'|'medium'|'low', description, issues[] }
 */

const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIG
// ============================================================

const RPM_LIMIT = 15;       // Gemini Flash free tier supports 15 RPM
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

// ============================================================
// PRODUCTION-YEAR-AWARE VERIFICATION PROMPT
// ============================================================

const VERIFICATION_PROMPT = `You are verifying promotional images for Broadway shows. I will show you an image that is supposed to be for a SPECIFIC Broadway production.

Your task: Look for EVIDENCE that this image is WRONG. Only reject when you see positive proof of a problem. When in doubt, ACCEPT.

REJECT (match=false) only when you see POSITIVE EVIDENCE of these problems:
- The image shows a DIFFERENT SHOW's title (e.g., image says "Hell's Kitchen" but the show is "Illinoise"). This is the most important check.
- The image shows the show's name but with EXTRA WORDS forming a different title (e.g., "Cats: The Jellicle Ball" is NOT "Cats" — the subtitle makes it a different show). Any added subtitle, prefix, or qualifier visible in the image that doesn't match the exact title given below means it's a different show.
- The image shows a non-Broadway venue name (text like "BAM", "Steppenwolf", "State Theatre New Jersey", "West End", etc.)
- The image is clearly a "concert version" or "in concert" variant (visible text says "In Concert")
- The image is a generic placeholder: "Coming soon", stock photo, blank/solid color, website logo, app icon
- The image shows a yellow PLAYBILL program cover (physical program photo, not promotional art)
- The image is a seating chart, venue map, ticket listing, or social media logo
- The image shows a completely different show's recognizable artwork or cast

ACCEPT (match=true) in these cases:
- The image shows the correct show title — accept even if you can't confirm the exact production year
- Promotional art, logos, production photos, or cast photos that plausibly match the show — accept
- Closing notice images ("Final Performance", "Must Close") for the correct show — accept
- You cannot determine whether the image is from this specific production year vs another year — ACCEPT (benefit of the doubt)
- Simple text-based logos or stylized title treatments showing the right title — accept

KEY PRINCIPLE: If the image title matches the show title and there's no visible evidence of a wrong venue/production, ACCEPT IT. Do not reject just because you can't confirm the exact year.

Reply with ONLY this JSON (no markdown fencing, no explanation):
{"match":true,"confidence":"high","description":"brief description of what the image shows","issues":[],"imageType":"promotional_art"}

Or if there's a problem:
{"match":false,"confidence":"high","description":"brief description of what the image actually shows","issues":["category"],"imageType":"other"}

Issue categories: wrong_show, wrong_production, non_broadway, placeholder, playbill_cover, seating_chart, generic_image, social_media_logo, ticket_listing, venue_photo

Also classify the image type. Add an "imageType" field to your JSON response:
- "promotional_art" — Official poster, key art, logo treatment, title card with stylized design, marketing material
- "production_still" — Photo from actual stage performance, rehearsal, or backstage
- "headshot_cast" — Individual actor headshot or cast photo not from the show itself
- "other" — Anything else (venue exterior, playbill, generic)

Confidence levels:
- "high": You are very sure of your assessment
- "medium": You think you're right but aren't certain
- "low": You're guessing`;

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
    this.timestamps = this.timestamps.filter(t => now - t < 60000);
    if (this.timestamps.length >= this.rpm) {
      const oldest = this.timestamps[0];
      const waitMs = 60000 - (now - oldest) + 100;
      if (waitMs > 0) {
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
    this.timestamps.push(Date.now());
  }
}

// ============================================================
// GEMINI CLIENT (lazy-initialized)
// ============================================================

let geminiModel = null;
let initAttempted = false;

function getGeminiModel() {
  if (geminiModel) return geminiModel;
  if (initAttempted) return null;
  initAttempted = true;

  let apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const envPath = path.join(__dirname, '..', '..', '.env');
    if (fs.existsSync(envPath)) {
      const match = fs.readFileSync(envPath, 'utf8').match(/GEMINI_API_KEY=(.+)/);
      if (match) {
        apiKey = match[1].trim();
        process.env.GEMINI_API_KEY = apiKey;
      }
    }
  }

  if (!apiKey) return null;

  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  geminiModel = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 300,
    }
  });
  return geminiModel;
}

// ============================================================
// RESPONSE PARSER
// ============================================================

function parseResponse(text) {
  let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      match: Boolean(parsed.match),
      confidence: parsed.confidence || 'low',
      description: parsed.description || '',
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      imageType: parsed.imageType || 'other',
    };
  } catch {
    const matchResult = /\"match\"\s*:\s*(true|false)/i.exec(cleaned);
    const confResult = /\"confidence\"\s*:\s*\"(high|medium|low)\"/i.exec(cleaned);
    const descResult = /\"description\"\s*:\s*\"([^\"]*)\"/i.exec(cleaned);
    const typeResult = /\"imageType\"\s*:\s*\"(promotional_art|production_still|headshot_cast|other)\"/i.exec(cleaned);
    if (matchResult) {
      return {
        match: matchResult[1] === 'true',
        confidence: confResult?.[1] || 'low',
        description: descResult?.[1] || 'Could not fully parse response',
        issues: [],
        imageType: typeResult?.[1] || 'other',
      };
    }
    return {
      match: null,
      confidence: 'error',
      description: `Unparseable response: ${cleaned.substring(0, 200)}`,
      issues: ['parse_error'],
      imageType: 'other',
    };
  }
}

// ============================================================
// MIME TYPE DETECTION
// ============================================================

function getMimeType(urlOrPath) {
  const lower = (urlOrPath || '').toLowerCase().split('?')[0];
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.includes('fm=webp')) return 'image/webp';
  return 'image/jpeg';
}

// ============================================================
// MAIN VERIFICATION FUNCTION
// ============================================================

/**
 * Verify that an image matches a specific Broadway production.
 *
 * @param {Buffer|string} imageInput - Image data (Buffer) or URL (string, auto-downloaded)
 * @param {string} showTitle - Show title (e.g., "Hamlet")
 * @param {object} options
 * @param {string} options.year - Production year (e.g., "2009")
 * @param {string} options.openingDate - Full opening date (year extracted if options.year not set)
 * @param {RateLimiter} options.rateLimiter - Shared rate limiter instance
 * @returns {Promise<{match: boolean, confidence: string, description: string, issues: string[]}>}
 */
async function verifyImage(imageInput, showTitle, options = {}) {
  const model = getGeminiModel();
  if (!model) {
    return {
      match: true,
      confidence: 'low',
      description: 'Verification skipped (no GEMINI_API_KEY)',
      issues: [],
      imageType: 'other',
    };
  }

  // Resolve production year
  const year = options.year
    || (options.openingDate ? options.openingDate.substring(0, 4) : null);

  // Build user prompt with year qualifier
  const userPrompt = year
    ? `The Broadway production is: "${showTitle}" (${year})\nThe EXACT title is "${showTitle}" — if the image shows a different or extended title (e.g., with a subtitle like "Show: The Subtitle"), that is a DIFFERENT show.\nIs this image correct promotional art for this specific ${year} Broadway production?`
    : `The Broadway show is: "${showTitle}"\nThe EXACT title is "${showTitle}" — if the image shows a different or extended title, that is a DIFFERENT show.\nIs this image a correct promotional image for this show?`;

  // Resolve image data
  let imageData;
  let mimeType;

  if (Buffer.isBuffer(imageInput)) {
    imageData = imageInput;
    mimeType = options.mimeType || 'image/jpeg';
  } else if (typeof imageInput === 'string') {
    // URL — download first
    try {
      const resp = await fetch(imageInput, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)' },
      });
      if (!resp.ok) {
        return {
          match: true, confidence: 'low',
          description: `Could not download image for verification: HTTP ${resp.status}`,
          issues: ['download_error'],
          imageType: 'other',
        };
      }
      imageData = Buffer.from(await resp.arrayBuffer());
      mimeType = resp.headers.get('content-type') || getMimeType(imageInput);
    } catch (err) {
      return {
        match: true, confidence: 'low',
        description: `Could not download image for verification: ${err.message}`,
        issues: ['download_error'],
        imageType: 'other',
      };
    }
  } else {
    return {
      match: true, confidence: 'low',
      description: 'Invalid image input type',
      issues: ['invalid_input'],
      imageType: 'other',
    };
  }

  // Pre-filter: reject tiny images (<2KB likely broken)
  if (imageData.length < 2000) {
    return {
      match: false, confidence: 'high',
      description: `Image too small (${imageData.length} bytes) — likely broken or placeholder`,
      issues: ['placeholder'],
      imageType: 'other',
    };
  }

  // Rate limit
  const rateLimiter = options.rateLimiter || new RateLimiter(RPM_LIMIT);
  await rateLimiter.wait();

  // Call Gemini with retry
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent([
        { text: VERIFICATION_PROMPT + '\n\n' + userPrompt },
        {
          inlineData: {
            data: imageData.toString('base64'),
            mimeType: mimeType,
          }
        }
      ]);

      const text = result.response.text().trim();
      return parseResponse(text);
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        const backoff = RETRY_BASE_MS * Math.pow(2, attempt - 1) + Math.random() * 1000;
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }

  // Fail open on API errors
  return {
    match: true,
    confidence: 'low',
    description: `Verification failed after ${MAX_RETRIES} retries: ${lastError?.message}`,
    issues: ['api_error'],
    imageType: 'other',
  };
}

// ============================================================
// URL HEURISTIC CLASSIFICATION
// ============================================================

/**
 * Classify image type from URL/filename patterns.
 * Used as a tiebreaker when Gemini classification is uncertain.
 */
function classifyImageUrl(url) {
  const lower = (url || '').toLowerCase();
  // Patterns suggesting promotional art
  if (/poster|key[_-]?art|logo|promo|official|title|artwork|keyart/.test(lower)) return 'promotional_art';
  // TodayTix API images are always promotional
  if (lower.includes('todaytix.imgix.net') || lower.includes('tix-content')) return 'promotional_art';
  // Contentful assets are typically curated promotional images
  if (lower.includes('images.ctfassets.net')) return 'promotional_art';
  // Patterns suggesting production stills
  if (/gallery|production|rehearsal|stage|perform|_r\d|IMG_|backstage/.test(lower)) return 'production_still';
  return 'unknown';
}

// ============================================================
// EXPORTS
// ============================================================

function createRateLimiter(rpm) {
  return new RateLimiter(rpm || RPM_LIMIT);
}

module.exports = { verifyImage, createRateLimiter, classifyImageUrl };
