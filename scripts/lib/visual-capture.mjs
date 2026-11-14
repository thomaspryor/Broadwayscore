// Shared by scripts/visual-qa.mjs and scripts/visual-identical.mjs (BRO-7491): one list of widths,
// one ad-host regex, one Chromium launcher, so the two drivers cannot drift apart.
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

// Same hosts as tests/e2e/helpers/test.ts AD_NETWORK_URL_RE (BRO-5893).
export const AD_NETWORK_URL_RE =
  /^https?:\/\/([^/?#]+\.)?(googlesyndication\.com|doubleclick\.net|adtrafficquality\.google|googleadservices\.com)(?=[/:?#]|$)/i;

export const WIDTHS = [360, 414, 768, 1024, 1440];

// Cloud sandboxes ship one preinstalled Chromium at /opt/pw-browsers/chromium
// (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, `playwright install` not allowed), which
// may not match the headless-shell build this repo's Playwright version asks
// for. Launch normally; if that build is missing, fall back to the
// preinstalled browser instead of failing the whole sweep (BRO-4481).
const PREINSTALLED_CHROMIUM = process.env.PW_CHROMIUM_EXECUTABLE || '/opt/pw-browsers/chromium';
export async function launchChromium() {
  try {
    return await chromium.launch();
  } catch (e) {
    if (!/Executable doesn't exist/.test(String(e?.message)) || !existsSync(PREINSTALLED_CHROMIUM)) throw e;
    console.log(`[visual-capture] bundled Chromium build missing, using ${PREINSTALLED_CHROMIUM}`);
    return chromium.launch({ executablePath: PREINSTALLED_CHROMIUM });
  }
}
