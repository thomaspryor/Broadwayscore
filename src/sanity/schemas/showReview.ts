import { defineField, defineType } from 'sanity';

/**
 * Tom's editorial reviews of specific shows.
 * Standalone — does NOT embed on show pages by design (per 2026-04-25 product call).
 * Lives at /reviews and /reviews/[slug] only.
 *
 * Schema mirrors the markdown frontmatter previously used in content/reviews/*.md
 * so the migration is loss-free.
 */
export const showReviewType = defineType({
  name: 'showReview',
  title: 'Show Review',
  type: 'document',
  fields: [
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
      validation: (rule) => rule.required().max(120),
    }),
    defineField({
      name: 'slug',
      title: 'Slug (URL)',
      type: 'slug',
      options: { source: 'title', maxLength: 96 },
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'show',
      title: 'Show name',
      type: 'string',
      description: 'Display name of the show, e.g. "The 25th Annual Putnam County Spelling Bee"',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'showSlug',
      title: 'Show slug (links to /show/[slug])',
      type: 'string',
      description:
        'Optional. The BWSC show ID, e.g. "giant-2026". Used for the "See all critic scores" cross-link.',
    }),
    defineField({
      name: 'venue',
      title: 'Venue',
      type: 'string',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'score',
      title: 'Score (0–100)',
      type: 'number',
      validation: (rule) => rule.required().min(0).max(100),
    }),
    defineField({
      name: 'dateAttended',
      title: 'Date attended',
      type: 'date',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'publishDate',
      title: 'Publish date',
      type: 'date',
      validation: (rule) => rule.required(),
      initialValue: () => new Date().toISOString().slice(0, 10),
    }),
    defineField({
      name: 'heroImage',
      title: 'Hero Image',
      type: 'image',
      options: { hotspot: true },
      fields: [
        defineField({
          name: 'alt',
          title: 'Alt text',
          type: 'string',
          validation: (rule) => rule.required(),
        }),
      ],
    }),
    defineField({
      name: 'excerpt',
      title: 'Excerpt (auto-generated if empty)',
      type: 'text',
      rows: 3,
      validation: (rule) => rule.max(280),
    }),
    defineField({
      name: 'body',
      title: 'Body',
      type: 'array',
      of: [
        { type: 'block' },
        {
          type: 'image',
          options: { hotspot: true },
          fields: [{ name: 'alt', type: 'string', title: 'Alt text' }],
        },
      ],
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'stressTest',
      title: 'Broadway Stress Test (optional)',
      description: 'Optional sidebar — sightlines, sound, intermission notes, etc.',
      type: 'array',
      of: [{ type: 'block' }],
    }),
  ],
  preview: {
    select: {
      title: 'title',
      show: 'show',
      score: 'score',
      media: 'heroImage',
      date: 'publishDate',
    },
    prepare({ title, show, score, media, date }) {
      const d = date ? new Date(date).toLocaleDateString() : 'Unpublished';
      return {
        title: title || 'Untitled',
        subtitle: `${show ? show + ' · ' : ''}${score}/100 · ${d}`,
        media,
      };
    },
  },
  orderings: [
    {
      title: 'Newest first',
      name: 'publishDateDesc',
      by: [{ field: 'publishDate', direction: 'desc' }],
    },
  ],
});
