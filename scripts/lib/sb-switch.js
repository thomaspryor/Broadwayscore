/**
 * BRO-8330: the one global ScrapingBee (SB) off switch.
 *
 * SCRAPINGBEE_DISABLED=1 (a repo variable, passed into every workflow job next to the key) means SB is
 * intentionally off: no SB request may be made and no SB-dependent check may go red. Only the exact value
 * '1' counts, so the workflow expression and the code can never disagree about what "off" means.
 *
 * Kill switch / rollback: unset the repo variable. The plan stays paid during the trial.
 *
 * Callers use scrapingBeeKey(env) instead of reading SCRAPINGBEE_API_KEY themselves; scripts/lib/sb-switch.test.mjs
 * fails if any file that talks to app.scrapingbee.com skips this module.
 */

function isScrapingBeeOff(env = process.env) {
  return String((env && env.SCRAPINGBEE_DISABLED) ?? '') === '1';
}

/** The SB key to use, or '' when SB is off or no key exists. `candidate` lets callers pass an options/.env key. */
function scrapingBeeKey(env = process.env, candidate) {
  if (isScrapingBeeOff(env)) return '';
  return (env && env.SCRAPINGBEE_API_KEY) || candidate || '';
}

/**
 * Remove the key from process.env when off, so a module that reads process.env.SCRAPINGBEE_API_KEY directly
 * (many scripts do, to pass it on as scrapingBeeKey) sees no key. Idempotent. Returns true when off.
 */
function scrubEnvIfOff(env = process.env) {
  if (!isScrapingBeeOff(env)) return false;
  if (env.SCRAPINGBEE_API_KEY) delete env.SCRAPINGBEE_API_KEY;
  return true;
}

/** One-line status for health checks and logs. */
function offStatusLine() {
  return 'ScrapingBee intentionally off (SCRAPINGBEE_DISABLED=1)';
}

scrubEnvIfOff();

module.exports = { isScrapingBeeOff, scrapingBeeKey, scrubEnvIfOff, offStatusLine };
