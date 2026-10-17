'use strict';

// Callers own cancellation: browser operations close their page in finally.
async function withDeadline(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} wall-clock timeout`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
