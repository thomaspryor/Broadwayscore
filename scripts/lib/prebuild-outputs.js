'use strict';

const { execFileSync } = require('node:child_process');

// Tracked artifacts written by prebuild generators. Keep the warning's path
// inventory here, including the src/ artifact that is not a generator edit.
const PREBUILD_OUTPUTS = [
  /^data\/gold-lists-computed\.json$/,
  /^data\/slug-redirects(?:-compact)?\.json$/,
  /^public\/brand-tokens\.json$/,
  /^src\/config\/outlet-logos-generated\.json$/,
  /^public\/data\/(?:mobile-shows|search-shows|header-search-extra|diary-search|analyst-shows|analyst-creatives)\.json$/,
  /^public\/data\/(?:homepage|off-broadway|off-west-end|west-end)-archive\.json$/,
  /^public\/data\/shows\/[^/]+\.json$/,
];

function prebuildWarning(staged) {
  const isOutput = (file) => PREBUILD_OUTPUTS.some((pattern) => pattern.test(file));
  const outputs = staged.filter(isOutput);
  if (!outputs.length || staged.some((file) => /^(?:src|scripts)\//.test(file) && !isOutput(file))) return '';
  return 'WARNING: staged prebuild outputs without a src/ or scripts/ generator change:\n'
    + outputs.map((file) => `  ${file}`).join('\n')
    + '\nLocal build artifacts may be stale. Review these paths and unstage unintended changes with git restore --staged -- <path>.\n';
}

function main() {
  const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=ACMR', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const warning = prebuildWarning(staged);
  if (warning) console.warn(warning);
}

module.exports = { PREBUILD_OUTPUTS, prebuildWarning, main };
if (require.main === module) main();
