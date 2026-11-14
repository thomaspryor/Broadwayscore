/**
 * Playwright launch fallback for cloud sessions (BRO-6258).
 *
 * The repo pins playwright ^1.58, which looks for chromium build 1234 under
 * PLAYWRIGHT_BROWSERS_PATH. The cloud image ships a different build
 * (/opt/pw-browsers/chromium-1243, symlinked as /opt/pw-browsers/chromium) and
 * sets PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, so chromium.launch() died with
 * "Executable doesn't exist" and every Playwright tier fell through to paid
 * providers. launchExtras() returns { executablePath } only when Playwright's
 * own binary is missing and the image's chromium exists; otherwise {}, so Mac
 * and GitHub Actions launch exactly as before.
 */
const fs = require('fs');

const CLOUD_CHROMIUM = '/opt/pw-browsers/chromium';

/**
 * Pure: decide the executablePath override.
 * @param {{ bundled: string|null, exists: (p:string)=>boolean, fallback?: string }} o
 */
function pickExecutable({ bundled, exists, fallback = CLOUD_CHROMIUM }) {
  if (bundled && exists(bundled)) return null;
  return exists(fallback) ? fallback : null;
}

function launchExtras(chromium) {
  let bundled = null;
  try { bundled = chromium && chromium.executablePath(); } catch { /* browser build not resolvable */ }
  const exe = pickExecutable({ bundled, exists: (p) => fs.existsSync(p) });
  return exe ? { executablePath: exe } : {};
}

module.exports = { launchExtras, pickExecutable, CLOUD_CHROMIUM };
