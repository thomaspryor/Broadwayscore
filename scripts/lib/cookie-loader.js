/**
 * Shared Cookie Loader
 *
 * Single source of truth for loading browser cookies across all scripts.
 * 3-tier fallback: COOKIES_BUNDLE_* env vars → individual env vars → local files.
 *
 * Used by: collect-review-texts.js, check-cookie-health.js,
 *          recover-wsj-subscriber.js, recollect-for-scores.js
 */

const fs = require('fs');
const path = require('path');

// Project root (where data/ lives)
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const COOKIE_DIR = path.join(PROJECT_ROOT, 'data', 'cookies');

// ============================================================================
// Domain → env var / file key mapping (single source of truth)
// ============================================================================

const COOKIE_DOMAIN_MAP = {
  'wsj.com': { envVar: 'WSJ_COOKIES', fileKey: 'wsj' },
  'newyorker.com': { envVar: 'NEWYORKER_COOKIES', fileKey: 'newyorker' },
  'nytimes.com': { envVar: 'NYT_COOKIES', fileKey: 'nytimes' },
  'vulture.com': { envVar: 'VULTURE_COOKIES', fileKey: 'vulture' },
  'nymag.com': { envVar: 'VULTURE_COOKIES', fileKey: 'vulture' },
  'washingtonpost.com': { envVar: 'WAPO_COOKIES', fileKey: 'wapo' },
  'ft.com': { envVar: 'FT_COOKIES', fileKey: 'ft' },
  'timeout.com': { envVar: 'TIMEOUT_COOKIES', fileKey: 'timeout' },
  'nypost.com': { envVar: 'NYPOST_COOKIES', fileKey: 'nypost' },
  'nydailynews.com': { envVar: 'NYDAILYNEWS_COOKIES', fileKey: 'nydailynews' },
  'deadline.com': { envVar: 'DEADLINE_COOKIES', fileKey: 'deadline' },
  'observer.com': { envVar: 'OBSERVER_COOKIES', fileKey: 'observer' },
  'hollywoodreporter.com': { envVar: 'THR_COOKIES', fileKey: 'hollywoodreporter' },
  'variety.com': { envVar: 'VARIETY_COOKIES', fileKey: 'variety' },
  'indiewire.com': { envVar: 'INDIEWIRE_COOKIES', fileKey: 'indiewire' },
  'ew.com': { envVar: 'EW_COOKIES', fileKey: 'ew' },
  'theatermania.com': { envVar: 'THEATERMANIA_COOKIES', fileKey: 'theatermania' },
  'huffpost.com': { envVar: 'HUFFPOST_COOKIES', fileKey: 'huffpost' },
  'huffingtonpost.com': { envVar: 'HUFFPOST_COOKIES', fileKey: 'huffpost' },
  'usatoday.com': { envVar: 'USATODAY_COOKIES', fileKey: 'usatoday' },
  'northjersey.com': { envVar: 'NORTHJERSEY_COOKIES', fileKey: 'northjersey' },
  'bloomberg.com': { envVar: 'BLOOMBERG_COOKIES', fileKey: 'bloomberg' },
  'thestage.co.uk': { envVar: 'THESTAGE_COOKIES', fileKey: 'thestage' },
  'talkinbroadway.com': { envVar: 'TALKINBROADWAY_COOKIES', fileKey: 'talkinbroadway' },
  'backstage.com': { envVar: 'BACKSTAGE_COOKIES', fileKey: 'backstage' },
  'amny.com': { envVar: 'AMNY_COOKIES', fileKey: 'amny' },
  'frontmezzjunkies.com': { envVar: 'FRONTMEZZJUNKIES_COOKIES', fileKey: 'frontmezzjunkies' },
  'telegraph.co.uk': { envVar: 'TELEGRAPH_COOKIES', fileKey: 'telegraph' },
  'thetimes.co.uk': { envVar: 'THETIMES_COOKIES', fileKey: 'thetimes' },
  'thetimes.com': { envVar: 'THETIMES_COOKIES', fileKey: 'thetimes' },
  'standard.co.uk': { envVar: 'STANDARD_COOKIES', fileKey: 'standard' },
  'independent.co.uk': { envVar: 'INDEPENDENT_COOKIES', fileKey: 'independent' },
  'chicagotribune.com': { envVar: 'CHICAGOTRIBUNE_COOKIES', fileKey: 'chicagotribune' },
  'thewrap.com': { envVar: 'THEWRAP_COOKIES', fileKey: 'thewrap' },
  'nbcnewyork.com': { envVar: 'NBCNEWYORK_COOKIES', fileKey: 'nbcnewyork' },
  'newsday.com': { envVar: 'NEWSDAY_COOKIES', fileKey: 'newsday' },
  'curtainup.com': { envVar: 'CURTAINUP_COOKIES', fileKey: 'curtainup' },
  'theaterscene.net': { envVar: 'THEATERSCENE_COOKIES', fileKey: 'theaterscene' },
};

// Reverse map: fileKey → envVar (for check-cookie-health which looks up by fileKey)
const FILE_KEY_TO_ENV_VAR = {};
for (const config of Object.values(COOKIE_DOMAIN_MAP)) {
  FILE_KEY_TO_ENV_VAR[config.fileKey] = config.envVar;
}

// ============================================================================
// Bundle loading (Tier 1: COOKIES_BUNDLE_* env vars)
// ============================================================================

let _bundleCache = null;
let _bundleMetaCache = null;

/**
 * Parse all COOKIES_BUNDLE_* env vars into a single map: { fileKey: [cookies] }
 * Cached after first call.
 *
 * Bundles may also contain a `_meta` key (object, not array) with extraction
 * metadata — extracted into _bundleMetaCache and not surfaced as cookies.
 */
function loadBundles() {
  if (_bundleCache !== null) return _bundleCache;
  _bundleCache = {};
  _bundleMetaCache = {};

  for (const [key, val] of Object.entries(process.env)) {
    if (!key.startsWith('COOKIES_BUNDLE_') || !val) continue;
    try {
      const decoded = Buffer.from(val, 'base64').toString('utf-8');
      const bundle = JSON.parse(decoded);
      if (typeof bundle === 'object' && !Array.isArray(bundle)) {
        const meta = bundle._meta && typeof bundle._meta === 'object' ? bundle._meta : null;
        for (const [outletKey, cookies] of Object.entries(bundle)) {
          if (outletKey.startsWith('_')) continue;
          if (Array.isArray(cookies) && cookies.length > 0) {
            _bundleCache[outletKey] = cookies;
            if (meta) _bundleMetaCache[outletKey] = meta;
          }
        }
      }
    } catch (e) {
      console.log(`  ⚠ Failed to parse ${key}: ${e.message}`);
    }
  }

  const count = Object.keys(_bundleCache).length;
  if (count > 0) {
    console.log(`  🍪 Loaded cookie bundles: ${count} outlets from COOKIES_BUNDLE_* env vars`);
  }
  return _bundleCache;
}

let _fileMetaCache = null;

function loadFileMeta() {
  if (_fileMetaCache !== null) return _fileMetaCache;
  _fileMetaCache = {};
  const metaPath = path.join(COOKIE_DIR, '_extracted-at.json');
  if (!fs.existsSync(metaPath)) return _fileMetaCache;
  try {
    _fileMetaCache = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch (e) {
    // Surface — otherwise staleness silently passes for every outlet.
    console.log(`  ⚠ Failed to parse ${metaPath}: ${e.message}`);
  }
  return _fileMetaCache;
}

/**
 * Return extraction metadata for a fileKey, or null.
 * Shape: { extractedAt: ISOString, extractedAtUnix: number, source: 'bundle'|'file' }
 * Bundle metadata wins over file metadata (matches the load order in
 * loadCookiesByFileKey — bundles are tier 1).
 */
function loadCookieMeta(fileKey) {
  loadBundles();
  const bundleMeta = _bundleMetaCache && _bundleMetaCache[fileKey];
  if (bundleMeta && (bundleMeta.extractedAt || bundleMeta.extractedAtUnix)) {
    return { ...bundleMeta, source: 'bundle' };
  }
  const fileMeta = loadFileMeta()[fileKey];
  if (fileMeta && (fileMeta.extractedAt || fileMeta.extractedAtUnix)) {
    return { ...fileMeta, source: 'file' };
  }
  return null;
}

// ============================================================================
// Cookie cache
// ============================================================================

const _cookieCache = {};

// ============================================================================
// Public API
// ============================================================================

/**
 * Load cookies for a given domain.
 * Fallback order: COOKIES_BUNDLE_* → individual env var → local file.
 * Returns Playwright-compatible cookie array or null.
 */
function loadCookiesForDomain(domain) {
  const normalizedDomain = domain.replace(/^www\./, '');

  if (_cookieCache[normalizedDomain] !== undefined) {
    return _cookieCache[normalizedDomain];
  }

  const cookieConfig = COOKIE_DOMAIN_MAP[normalizedDomain];
  if (!cookieConfig) {
    _cookieCache[normalizedDomain] = null;
    return null;
  }

  // Tier 1: COOKIES_BUNDLE_* env vars
  const bundles = loadBundles();
  if (bundles[cookieConfig.fileKey]) {
    const cookies = bundles[cookieConfig.fileKey];
    console.log(`  🍪 Loaded ${cookies.length} cookies for ${normalizedDomain} from bundle`);
    _cookieCache[normalizedDomain] = cookies;
    return cookies;
  }

  // Tier 2: Individual env var (backward compat)
  const envVal = process.env[cookieConfig.envVar];
  if (envVal) {
    try {
      const decoded = Buffer.from(envVal, 'base64').toString('utf-8');
      const cookies = JSON.parse(decoded);
      if (Array.isArray(cookies) && cookies.length > 0) {
        console.log(`  🍪 Loaded ${cookies.length} cookies for ${normalizedDomain} from env ${cookieConfig.envVar}`);
        _cookieCache[normalizedDomain] = cookies;
        return cookies;
      }
    } catch (e) {
      console.log(`  ⚠ Failed to parse ${cookieConfig.envVar} env var: ${e.message}`);
    }
  }

  // Tier 3: Local file
  const cookieFilePath = path.join(COOKIE_DIR, `${cookieConfig.fileKey}.json`);
  if (fs.existsSync(cookieFilePath)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(cookieFilePath, 'utf-8'));
      if (Array.isArray(cookies) && cookies.length > 0) {
        console.log(`  🍪 Loaded ${cookies.length} cookies for ${normalizedDomain} from ${cookieFilePath}`);
        _cookieCache[normalizedDomain] = cookies;
        return cookies;
      }
    } catch (e) {
      console.log(`  ⚠ Failed to parse cookie file ${cookieFilePath}: ${e.message}`);
    }
  }

  _cookieCache[normalizedDomain] = null;
  return null;
}

/**
 * Load cookies by fileKey (e.g., 'wsj', 'hollywoodreporter').
 * Used by check-cookie-health.js which iterates by fileKey, not domain.
 * Returns { source: 'bundle'|'env'|'file', cookies: [] } or null.
 */
function loadCookiesByFileKey(fileKey) {
  // Tier 1: Bundles
  const bundles = loadBundles();
  if (bundles[fileKey]) {
    return { source: 'bundle', cookies: bundles[fileKey] };
  }

  // Tier 2: Individual env var
  const envVar = FILE_KEY_TO_ENV_VAR[fileKey];
  if (envVar && process.env[envVar]) {
    try {
      const decoded = Buffer.from(process.env[envVar], 'base64').toString('utf-8');
      const cookies = JSON.parse(decoded);
      if (Array.isArray(cookies)) return { source: 'env', cookies };
    } catch {}
  }

  // Tier 3: Local file
  const filePath = path.join(COOKIE_DIR, `${fileKey}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (Array.isArray(cookies)) return { source: 'file', cookies };
    } catch {}
  }

  return null;
}

/**
 * Check if cookies are available for a URL's domain.
 * Returns the domain key if cookies exist, null otherwise.
 */
function hasCookiesForUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    for (const domain of Object.keys(COOKIE_DOMAIN_MAP)) {
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        const cookies = loadCookiesForDomain(domain);
        if (cookies) return domain;
      }
    }
  } catch {}
  return null;
}

/**
 * Build an HTTP Cookie header string for a URL's domain.
 * Returns "name1=val1; name2=val2" or null if no cookies available.
 */
function buildCookieHeaderForUrl(url) {
  const domain = hasCookiesForUrl(url);
  if (!domain) return null;

  const cookies = loadCookiesForDomain(domain);
  if (!cookies || cookies.length === 0) return null;

  const hostname = new URL(url).hostname.replace(/^www\./, '');
  return cookies
    .filter(c => c.name && c.value && c.domain)
    .filter(c => {
      const cookieDomain = c.domain.replace(/^\./, '');
      return hostname === cookieDomain || hostname.endsWith('.' + cookieDomain) ||
             cookieDomain === hostname || cookieDomain.endsWith('.' + hostname);
    })
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Get the env var name for a fileKey (e.g., 'hollywoodreporter' → 'THR_COOKIES').
 * Used by check-cookie-health.js for reporting.
 */
function getEnvVarForFileKey(fileKey) {
  return FILE_KEY_TO_ENV_VAR[fileKey] || null;
}

/**
 * Get all fileKeys (for iteration in check-cookie-health.js).
 */
function getAllFileKeys() {
  return Object.keys(FILE_KEY_TO_ENV_VAR);
}

/**
 * Clear all caches (useful for testing).
 */
function clearCache() {
  Object.keys(_cookieCache).forEach(k => delete _cookieCache[k]);
  _bundleCache = null;
  _bundleMetaCache = null;
  _fileMetaCache = null;
}

module.exports = {
  COOKIE_DOMAIN_MAP,
  FILE_KEY_TO_ENV_VAR,
  loadCookiesForDomain,
  loadCookiesByFileKey,
  loadCookieMeta,
  hasCookiesForUrl,
  buildCookieHeaderForUrl,
  getEnvVarForFileKey,
  getAllFileKeys,
  clearCache,
  COOKIE_DIR,
};
