/**
 * Sanity Studio config — mounted at /studio in the Next.js app.
 * Contractors log in at broadwayscorecard.com/studio with Google/email.
 * Roles are managed in sanity.io/manage — remove user there to revoke.
 */
import { defineConfig } from 'sanity';
import { structureTool } from 'sanity/structure';
import { visionTool } from '@sanity/vision';

import { apiVersion, dataset, projectId } from './src/sanity/env';
import { schemaTypes } from './src/sanity/schemas';

export default defineConfig({
  name: 'bwsc-blog',
  title: 'Broadway Scorecard — Editorial',
  basePath: '/studio',
  projectId,
  dataset,
  plugins: [structureTool(), visionTool({ defaultApiVersion: apiVersion })],
  schema: { types: schemaTypes },
});
