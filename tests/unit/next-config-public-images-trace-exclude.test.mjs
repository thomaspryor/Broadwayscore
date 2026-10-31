// BRO-6310: a server file that does fs.existsSync(path.join(process.cwd(),'public',<dynamic>))
// makes Next's file tracing bundle ALL of public/images (~640MB) into every page
// function; Vercel then rejects the deploy (>250MB uncompressed). 11 failed
// "Deploy to Vercel" runs on 2026-10-26. The exclude in next.config.js is the guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cfg = require('../../next.config.js');

test('next.config excludes public/images from function tracing', () => {
  assert.ok(cfg.outputFileTracingExcludes['**/*'].includes('public/images/**'));
});

test('no src file reads public/images with a literal path (runtime read would be excluded)', () => {
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js)$/.test(e.name)) {
        const t = fs.readFileSync(p, 'utf8');
        if (/(readFile|readFileSync|readdirSync|statSync)\([^)]*public[^)]*images/.test(t)) offenders.push(p);
      }
    }
  };
  walk('src');
  assert.deepEqual(offenders, []);
});
