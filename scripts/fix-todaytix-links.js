#!/usr/bin/env node

// The weekly workflow calls this entry point; tests exercise the real writer.
const { main } = require('./lib/todaytix-link-checker');

if (require.main === module) main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
