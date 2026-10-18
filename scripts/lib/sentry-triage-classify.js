/**
 * Noise vs real classification for scripts/triage-sentry.js, kept here so it can
 * be unit-tested against real event shapes (tests/unit/sentry-triage-classify.test.js).
 * Sentry's API returns frame fields in camelCase (lineNo, absPath).
 */

// --- Noise detection patterns ---

// "Cannot read properties of undefined/null" is deliberately NOT here: the page's
// Sentry beforeSend only forwards events with a frame on our own domain, so that
// message is usually our bug (BRO-5565: the webpack "reading 'call'" stale-deploy
// crash was auto-ignored for months). Stack-based rules below decide.
const NOISE_MESSAGE_PATTERNS = [
  /swal/i,
  /sweetalert/i,
  /invalid origin/i,
  /blocked a frame with origin/i,
  /@context/,
  /ResizeObserver loop/i,
  /loading chunk \d+ failed/i,
  /ChunkLoadError/i,
  /NetworkError when attempting to fetch/i,
  /Failed to fetch/i,
  /Load failed/i,
  /AbortError/i,
  /NotAllowedError/i,
  /webkit-masked-url/i,
  /Script error\.?$/i,
  /Non-Error promise rejection captured/i,
  /Unexpected token/i,
  /Object Not Found Matching Id/i,
  /a\[e\] is not a function/i,
  /instantSearchSDKJSBridgeClearHighlight/i,
  // Injected by in-app browsers / ancient engines, found in the 2026-10 digest (BRO-5565):
  /Can't find variable: _G\b/,
  /private fields are not currently supported/i,
  /fb_xd_fragment/i,
  /googletag/i,
  /google-analytics/i,
  /ytcfg/i,
  /vid_mate_check/i,
  /zaloJSV2/i,
  /UCShellJava/i,
];

const NOISE_URL_PATTERNS = [
  /extensions?\//i,
  /^chrome:\/\//i,
  /^chrome-extension:\/\//i,
  /^moz-extension:\/\//i,
  /^safari-extension:\/\//i,
  /^safari-web-extension:\/\//i,
  /^webkit-masked-url:\/\//i,
  /translate\.google/i,
  /googletagmanager\.com/i,
  /clarity\.ms/i,
  /google-analytics\.com/i,
  /doubleclick\.net/i,
  /facebook\.com/i,
  /connect\.facebook/i,
];

const OUR_DOMAIN_PATTERNS = [
  /broadwayscorecard\.com/,
  /broadwayscorecard-.*\.vercel\.app/,
];

// Our pages ship as 4-5 line HTML documents, so a frame whose file is the page
// URL itself (not a .js bundle) at a line past this cannot be our inline code.
// Chrome on iOS injects scripts that report the page URL as their filename
// (BRO-5565: RangeError "Maximum call stack size exceeded" at /:225).
const MAX_DOCUMENT_LINE = 20;

// The post-deploy webpack missing-module crash (BRO-5565). The client reloads
// once on it (src/lib/stale-deploy-reload.ts), but the event still reaches
// Sentry and the minified names change every deploy, so each deploy would
// open a new issue and a new GitHub issue. Ignored in Sentry, it stays visible
// in the weekly digest and in PostHog `stale_deploy_reload`.
const STALE_DEPLOY_MESSAGE = /reading 'call'|evaluating '[\w$]+\[[\w$]+\]\.call'|[\w$]+\[[\w$]+\] is undefined/;

function isStaleDeployIssue(issue, latestEvent) {
  const text = `${issue.title || ''} ${(issue.metadata || {}).value || ''}`;
  if (!STALE_DEPLOY_MESSAGE.test(text)) return false;
  const frames = latestEvent?.entries?.find(e => e.type === 'exception')?.data?.values?.[0]?.stacktrace?.frames;
  if (frames?.length) {
    return frames.some(f => /_next\/static\/chunks\/webpack/.test(f.filename || f.absPath || ''));
  }
  // No event to read: the culprit Sentry computed names the runtime chunk.
  return /chunks\/webpack/.test(issue.culprit || '');
}

function isInjectedDocumentFrame(f) {
  const filename = f.filename || f.absPath || '';
  if (/\.(m?js|cjs)(\?|$)/i.test(filename)) return false;
  const line = f.lineNo ?? f.lineno;
  return typeof line === 'number' && line > MAX_DOCUMENT_LINE;
}

// --- Classification ---

function classifyIssue(issue, latestEvent) {
  const title = issue.title || '';
  const culprit = issue.culprit || '';
  const metadata = issue.metadata || {};
  const message = metadata.value || title;

  if (isStaleDeployIssue(issue, latestEvent)) {
    return { noise: true, reason: 'Stale tab after a deploy (webpack missing module); handled by stale-deploy-reload, counted in PostHog stale_deploy_reload' };
  }

  // Check message patterns
  for (const pattern of NOISE_MESSAGE_PATTERNS) {
    if (pattern.test(title) || pattern.test(message) || pattern.test(culprit)) {
      return { noise: true, reason: `Message matches noise pattern: ${pattern}` };
    }
  }

  // Check stack trace if available
  if (latestEvent) {
    const exception = latestEvent.entries?.find(e => e.type === 'exception');
    const frames = exception?.data?.values?.[0]?.stacktrace?.frames || [];

    if (frames.length === 0) {
      return { noise: true, reason: 'No stack trace (cannot attribute to our code)' };
    }

    // Check if any frame is from a noisy URL
    const allNoisy = frames.every(f => {
      const filename = f.filename || f.absPath || '';
      return NOISE_URL_PATTERNS.some(p => p.test(filename)) ||
        (!OUR_DOMAIN_PATTERNS.some(p => p.test(filename)) && filename.startsWith('http'));
    });

    if (allNoisy) {
      return { noise: true, reason: 'All stack frames from third-party/extension code' };
    }

    const ourFrames = frames.filter(f => {
      const filename = f.filename || f.absPath || '';
      return OUR_DOMAIN_PATTERNS.some(p => p.test(filename));
    });

    if (ourFrames.length === 0) {
      return { noise: true, reason: 'No stack frames from our domain' };
    }

    if (ourFrames.every(isInjectedDocumentFrame)) {
      return { noise: true, reason: 'Only frames inside the page document past its last line (browser-injected script)' };
    }
  }

  // Check if it's a low-frequency issue (1-2 events from a single user)
  // These are usually one-off browser quirks
  if (issue.count && parseInt(issue.count) <= 2 && issue.userCount && parseInt(issue.userCount) <= 1) {
    // Still report it, but note it's low-frequency
    return { noise: false, lowFrequency: true, reason: 'Low frequency (1-2 events, 1 user)' };
  }

  return { noise: false, reason: 'Appears to be a real issue from our code' };
}

module.exports = { classifyIssue, isInjectedDocumentFrame, isStaleDeployIssue, NOISE_MESSAGE_PATTERNS, OUR_DOMAIN_PATTERNS };
