'use strict';

function createCollectorChromium() {
  const { addExtra } = require('playwright-extra');
  // The setup-playwright action installs browsers for this package's CLI.
  // playwright-extra's default export prefers playwright-core, which can
  // resolve to a different version and request a browser CI never installed.
  return addExtra(require('playwright').chromium);
}

module.exports = { createCollectorChromium };
