import { FlatCompat } from '@eslint/eslintrc';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Flat config replacing .eslintrc.json (BRO-5215: Next 16 removes `next lint`).
// FlatCompat keeps the same next/core-web-vitals rule set `next lint` used.
const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

export default [...compat.extends('next/core-web-vitals')];
