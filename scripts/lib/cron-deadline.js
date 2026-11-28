'use strict';

const { withTimeout } = require('./with-timeout');

// Callers own cancellation: browser operations close their page in finally.
async function withDeadline(operation, timeoutMs, label) {
  return withTimeout(operation, timeoutMs, { message: `${label} wall-clock timeout` });
}

async function closeBrowserServer(server, timeoutMs = 5000) {
  try {
    await withDeadline(() => server.close(), timeoutMs, 'Browser close');
  } catch (error) {
    console.warn(String(error));
    server.process().kill('SIGKILL');
  }
}

module.exports = { withDeadline, closeBrowserServer };
